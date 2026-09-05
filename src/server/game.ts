import { z } from "zod";
import { JavascriptExecutor } from "../shared/executor";
import { BUILD_ID } from "../shared/build";
import {
  MAX_RESULT,
  MAX_LOG_PACKET,
  VERSION,
  encodeOutcome,
  errorMessage,
  events,
  outcomeSchema,
  helloSchema,
  progressSchema,
  type ExecutionInput,
  type WireRequest,
} from "../shared/protocol";
import type { Config } from "./config";
import { Jobs } from "./jobs";
import { LogBuffer } from "./logs";

export function gameThread<T>(callback: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(callback());
      } catch (error) {
        reject(error);
      }
    });
  });
}

const resourceName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "Invalid resource name");
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class GameService {
  readonly buildId = BUILD_ID;
  readonly jobs: Jobs;
  readonly logs: LogBuffer;
  private readonly executor: JavascriptExecutor;
  private readonly names;
  private readonly clients = new Map<
    number,
    {
      lastSeen: number;
      version: string;
      buildId: string;
      nuiBuildId: string | null;
      nuiReady: boolean;
    }
  >();
  private stopping = false;
  private readonly sweep: ReturnType<typeof setInterval>;
  readonly consoleAvailable: boolean;
  private lastRejectedLog = -Infinity;
  private readonly logRates = new Map<
    number,
    { window: number; count: number }
  >();

  constructor(
    readonly resource: string,
    readonly config: Config,
  ) {
    this.jobs = new Jobs(config.maxActive);
    this.logs = new LogBuffer();
    this.names = events(resource);
    this.executor = new JavascriptExecutor({
      resource,
      exports,
      require,
      game: gameThread,
      print: (level, message) => console[level](message),
      progress: (packet) => this.receiveProgress(JSON.stringify(packet)),
    });
    this.consoleAvailable = typeof RegisterConsoleListener === "function";
    if (this.consoleAvailable) {
      RegisterConsoleListener((channel: string, message: string) => {
        if (this.stopping) return;
        const execution = String(message).match(/\[([0-9a-f-]{36})\]/i)?.[1];
        if (
          execution &&
          (String(message).startsWith(`[${execution}] `) ||
            String(message).startsWith(`[${this.resource}][${execution}] `)) &&
          this.jobs.list().some((job) => job.id === execution)
        )
          return;
        this.logs.add({
          source: "server",
          level: "info",
          channel: String(channel).slice(0, 128),
          message: String(message),
        });
      });
    }
    onNet(this.names.hello, (raw: unknown) => {
      const playerId = Number(source);
      if (
        !Number.isInteger(playerId) ||
        playerId <= 0 ||
        !GetPlayerName(String(playerId)) ||
        !IsPlayerAceAllowed(String(playerId), config.ace)
      )
        return;
      const parsed = helloSchema.safeParse(raw);
      if (!parsed.success) return;
      this.clients.set(playerId, { lastSeen: Date.now(), ...parsed.data });
      if (parsed.data.buildId !== BUILD_ID || parsed.data.version !== VERSION)
        this.jobs.disconnect(playerId);
    });
    onNet(this.names.result, (id: unknown, raw: unknown) => {
      const playerId = Number(source);
      if (typeof id !== "string" || !this.jobs.accepts(id, playerId)) return;
      if (!this.clientAuthorized(playerId)) {
        this.jobs.cancel(id);
        return;
      }
      this.receive(id, raw, playerId);
    });
    onNet(this.names.log, (raw: unknown) =>
      this.receiveProgress(raw, Number(source)),
    );
    on(this.names.luaLog, (raw: unknown) =>
      this.receiveProgress(raw, undefined, true),
    );
    on(this.names.luaResult, (id: unknown, raw: unknown) => {
      if (
        typeof id === "string" &&
        this.jobs.accepts(id) &&
        this.jobs.get(id).language === "lua"
      )
        this.receive(id, raw);
    });
    on("playerDropped", () => {
      const id = Number(source);
      this.clients.delete(id);
      this.logRates.delete(id);
      this.jobs.disconnect(id);
    });
    this.sweep = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (
          Date.now() - client.lastSeen > 20_000 ||
          !IsPlayerAceAllowed(String(id), config.ace)
        ) {
          this.clients.delete(id);
          this.logRates.delete(id);
          this.jobs.disconnect(id);
        }
      }
    }, 5000);
  }

  audit(message: string, error = false): void {
    this.logs.add({
      source: "audit",
      channel: this.resource,
      level: error ? "error" : "info",
      message,
    });
  }

  runtimeInfo() {
    return gameThread(() => ({
      resource: this.resource,
      resourceState: GetResourceState(this.resource),
      version: VERSION,
      buildId: BUILD_ID,
      artifact:
        typeof GetConvar === "function"
          ? GetConvar("version", "unavailable")
          : "unavailable",
      node: process.version,
      platform: process.platform,
      consoleAvailable: this.consoleAvailable,
      ace: this.config.ace,
      commandAces: Object.fromEntries(
        ["ensure", "start", "stop", "restart", "refresh"].map((command) => [
          command,
          Boolean(
            IsPrincipalAceAllowed(
              `resource.${this.resource}`,
              `command.${command}`,
            ),
          ),
        ]),
      ),
    }));
  }

  players() {
    return gameThread(() =>
      getPlayers().map((id) => {
        const client = this.clients.get(Number(id));
        const authorized = Boolean(IsPlayerAceAllowed(id, this.config.ace));
        const fresh = !!client && Date.now() - client.lastSeen < 20_000;
        const reasons = [
          ...(!authorized ? ["missing_ace"] : []),
          ...(!client ? ["missing_heartbeat"] : []),
          ...(client && !fresh ? ["stale_heartbeat"] : []),
          ...(client && client.version !== VERSION ? ["version_mismatch"] : []),
          ...(client && client.buildId !== BUILD_ID ? ["build_mismatch"] : []),
        ];
        return {
          playerId: Number(id),
          name: GetPlayerName(id),
          authorized,
          ready: reasons.length === 0,
          readinessReasons: reasons,
          lastSeen: client ? new Date(client.lastSeen).toISOString() : null,
          serverBuildId: BUILD_ID,
          clientBuildId: client?.buildId ?? null,
          nuiBuildId: client?.nuiBuildId ?? null,
          bridgeVersion: client?.version ?? null,
          nuiReady:
            reasons.length === 0 &&
            Boolean(client?.nuiReady) &&
            client?.nuiBuildId === BUILD_ID,
          nuiReadinessReason: !client?.nuiReady
            ? "missing_nui_readiness"
            : client.nuiBuildId !== BUILD_ID
              ? "nui_build_mismatch"
              : reasons.length
                ? "client_not_ready"
                : null,
        };
      }),
    );
  }

  resources() {
    return gameThread(() => {
      const result = [];
      for (let index = 0; index < GetNumResources(); index++) {
        const name = GetResourceByFindIndex(index);
        if (name) result.push({ name, state: GetResourceState(name) });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async manage(
    action: "ensure" | "start" | "stop" | "restart" | "refresh",
    name?: string,
  ) {
    return gameThread(() => {
      if (action !== "refresh") {
        resourceName.parse(name);
        if (name === this.resource)
          throw new Error(
            "Self-management is disabled; use the FXServer console to restart dolu_fivem_mcp.",
          );
        if (!name || GetResourceState(name) === "missing")
          throw new Error(
            "Resource not found; run refresh after adding a resource.",
          );
      }
      if (
        !IsPrincipalAceAllowed(`resource.${this.resource}`, `command.${action}`)
      ) {
        throw new Error(
          `Missing ACE: add_ace resource.${this.resource} command.${action} allow`,
        );
      }
      ExecuteCommand(action === "refresh" ? "refresh" : `${action} ${name}`);
      this.audit(`resource ${action} ${name ?? ""}`);
      return {
        action,
        resource: name ?? null,
        state: name ? GetResourceState(name) : null,
        note: "Command dispatched; inspect resource state and logs for readiness.",
      };
    });
  }

  async command(command: string) {
    if (!command.trim() || command.length > 4096 || /[\r\n\0]/.test(command))
      throw new Error("Expected a single non-empty console command");
    const words = command.trim().split(/\s+/);
    const verb = words[0];
    if (!verb || !/^[A-Za-z0-9_.:-]+$/.test(verb))
      throw new Error("Invalid command name");
    if (
      /^(quit|exit)$/i.test(verb) ||
      (/^(stop|restart|ensure)$/i.test(verb) && words[1] === this.resource)
    ) {
      throw new Error(
        "Stopping this MCP or FXServer must be done from the FXServer console.",
      );
    }
    return gameThread(() => {
      if (
        !IsPrincipalAceAllowed(`resource.${this.resource}`, `command.${verb}`)
      )
        throw new Error(`Missing command.${verb} ACE for this resource`);
      const cursor = this.logs.read().nextCursor;
      ExecuteCommand(command);
      this.audit(`console command ${verb}`);
      return {
        dispatched: true,
        logCursor: cursor,
        note: "Console output is asynchronous. Use read_logs with this cursor.",
      };
    });
  }

  async execute(
    target: "server" | "client",
    input: ExecutionInput,
    playerId?: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (Buffer.byteLength(input.code, "utf8") > 65_536)
      throw new Error("Code exceeds 65536 UTF-8 bytes");
    const launched = await gameThread(() => {
      signal?.throwIfAborted();
      if (this.stopping) throw new Error("Resource is stopping");
      const selected =
        target === "client" ? this.selectPlayer(playerId) : undefined;
      const result = this.jobs.start(
        target,
        input,
        selected,
        (request) => this.dispatch(request, selected),
        (id) => {
          void gameThread(() => {
            if (selected === undefined) {
              this.executor.cancel(id);
              emit(this.names.luaCancel, id);
            } else emitNet(this.names.cancel, selected, id);
          }).catch((error: unknown) => this.audit(errorMessage(error), true));
        },
      );
      if (input.wait && signal) {
        const abort = () => {
          if (result.job.state === "running") this.jobs.cancel(result.job.id);
        };
        signal.addEventListener("abort", abort, { once: true });
        void result.done.then(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      }
      this.audit(
        `execute ${result.job.id} ${target} ${input.language} player=${selected ?? "-"}`,
      );
      return result;
    });
    return input.wait ? launched.done : launched.job;
  }

  async assertLocalNui(playerId?: number) {
    return gameThread(() => {
      const selected = this.selectPlayer(
        playerId ?? (this.config.cdpPlayer || undefined),
      );
      const client = this.clients.get(selected);
      if (!client?.nuiReady || client.nuiBuildId !== BUILD_ID)
        throw new Error(
          "NUI is not ready or build-mismatched; refresh NUI and inspect players readiness.",
        );
      if (this.config.cdpPlayer && selected !== this.config.cdpPlayer)
        throw new Error(
          "Requested player is not the configured local CEF client",
        );
      if (!loopback.has(GetPlayerEndpoint(String(selected)))) {
        throw new Error(
          "NUI DevTools runs on the FXServer machine. Only a loopback-connected local client is supported.",
        );
      }
      const local = [...this.clients.keys()].filter((id) =>
        loopback.has(GetPlayerEndpoint(String(id))),
      );
      if (!this.config.cdpPlayer && local.length !== 1) {
        throw new Error(
          "Ambiguous local CEF ownership. Set dolu_fivem_mcp_cdp_player explicitly.",
        );
      }
      return selected;
    });
  }

  private selectPlayer(playerId?: number): number {
    const ready = [...this.clients.entries()]
      .filter(
        ([id, client]) =>
          client.version === VERSION &&
          client.buildId === BUILD_ID &&
          Date.now() - client.lastSeen < 20_000 &&
          !!GetPlayerName(String(id)) &&
          IsPlayerAceAllowed(String(id), this.config.ace),
      )
      .map(([id]) => id);
    if (playerId !== undefined) {
      if (!ready.includes(playerId))
        throw new Error(
          "Target is disconnected, not ready, version/build-mismatched or missing the MCP ACE; inspect players readinessReasons.",
        );
      return playerId;
    }
    if (ready.length !== 1 || ready[0] === undefined)
      throw new Error(
        `Specify playerId: ${ready.length} authorized clients are ready`,
      );
    return ready[0];
  }

  private dispatch(request: WireRequest, playerId?: number): void {
    if (playerId !== undefined) {
      emitNet(this.names.execute, playerId, JSON.stringify(request));
    } else if (request.language === "lua") {
      emit(this.names.luaExecute, JSON.stringify(request));
    } else {
      void this.executor.execute(request).then(
        (outcome) => this.receive(request.id, encodeOutcome(outcome)),
        (error: unknown) =>
          this.receive(
            request.id,
            encodeOutcome({
              ok: false,
              values: [],
              logs: [],
              durationMs: 0,
              error: errorMessage(error),
            }),
          ),
      );
    }
  }

  private receive(id: string, raw: unknown, playerId?: number): void {
    if (!this.jobs.accepts(id, playerId)) return;
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_RESULT)
        throw new Error("Invalid or oversized result envelope");
      const outcome = outcomeSchema.parse(JSON.parse(raw));
      const received = this.jobs.get(id).logs.length;
      if (!this.jobs.finish(id, outcome)) return;
      {
        for (const log of outcome.logs.slice(received))
          this.logs.add({
            ...log,
            source: playerId === undefined ? "server" : "client",
            channel: this.resource,
            playerId,
            executionId: id,
          });
      }

      this.audit(`execution ${id} ${outcome.ok ? "completed" : "failed"}`);
    } catch (error) {
      this.jobs.finish(id, {
        ok: false,
        values: [],
        logs: [],
        error: errorMessage(error),
        durationMs: 0,
      });
    }
  }

  private clientAuthorized(playerId: number): boolean {
    const client = this.clients.get(playerId);
    return (
      Number.isInteger(playerId) &&
      playerId > 0 &&
      Boolean(GetPlayerName(String(playerId))) &&
      Boolean(IsPlayerAceAllowed(String(playerId), this.config.ace)) &&
      !!client &&
      client.version === VERSION &&
      client.buildId === BUILD_ID &&
      Date.now() - client.lastSeen < 20_000
    );
  }

  private receiveProgress(raw: unknown, playerId?: number, lua = false): void {
    if (this.stopping) return;
    try {
      if (playerId !== undefined) {
        if (!this.clientAuthorized(playerId)) {
          if (Number.isInteger(playerId)) this.jobs.disconnect(playerId);
          throw new Error("Execution log authorization revoked");
        }
        const now = Date.now();
        let rate = this.logRates.get(playerId);
        if (!rate || now - rate.window >= 1000) {
          rate = { window: now, count: 0 };
          this.logRates.set(playerId, rate);
        }
        if (++rate.count > 200)
          throw new Error("Execution log packet rate exceeded");
      }
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_LOG_PACKET)
        throw new Error("Invalid execution log envelope");
      const packet = progressSchema.parse(JSON.parse(raw));
      if (!this.jobs.accepts(packet.id, playerId))
        throw new Error("Unbound or late execution log");
      if (lua && this.jobs.get(packet.id).language !== "lua")
        throw new Error("Execution log language mismatch");
      if (!this.jobs.progress(packet.id, packet.seq, packet.log, playerId))
        throw new Error("Duplicate, reordered or excessive execution log");
      this.logs.add({
        ...packet.log,
        source: playerId === undefined ? "server" : "client",
        channel: this.resource,
        playerId,
        executionId: packet.id,
      });
    } catch {
      // Untrusted packets must not amplify console/log traffic.
      if (Date.now() - this.lastRejectedLog >= 5000) {
        this.lastRejectedLog = Date.now();
        this.audit(
          "Rejected malformed, unauthorized, late or out-of-order execution log packet",
          true,
        );
      }
    }
  }
  close(): void {
    this.stopping = true;
    clearInterval(this.sweep);
    this.jobs.close();
    this.executor.close();
  }
}
