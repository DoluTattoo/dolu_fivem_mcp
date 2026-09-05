import { JavascriptExecutor } from "../shared/executor";
import { BUILD_ID } from "../shared/build";
import { scheduleTimeout } from "../shared/timer";
import {
  VERSION,
  MAX_RESULT,
  MAX_LOG_PACKET,
  encodeOutcome,
  errorMessage,
  events,
  outcomeSchema,
  wireRequestSchema,
  progressSchema,
} from "../shared/protocol";

const resource = GetCurrentResourceName();
const names = events(resource);
const pending = new Map<
  string,
  { language: string; seq: number; deadline: number; stop: () => void }
>();
let nuiReady = false;
let nuiBuildId: string | null = null;
let lastRejectedLog = -Infinity;
const executor = new JavascriptExecutor({
  resource,
  exports,
  print: (level, message) => console[level](message),
  progress: (packet) => sendProgress(JSON.stringify(packet), "javascript"),
});

function sendResult(id: string, raw: string): void {
  pending.get(id)?.stop();
  if (!pending.delete(id)) return;
  emitNet(names.result, id, raw);
}

function sendProgress(raw: unknown, language: string): void {
  try {
    if (typeof raw !== "string" || raw.length > MAX_LOG_PACKET)
      throw new Error("Invalid execution log envelope");
    const packet = progressSchema.parse(JSON.parse(raw));
    const state = pending.get(packet.id);
    if (
      !state ||
      state.language !== language ||
      state.deadline <= Date.now() ||
      packet.seq !== state.seq + 1
    )
      throw new Error("Unbound, late or reordered execution log");
    state.seq = packet.seq;
    emitNet(names.log, JSON.stringify(packet));
  } catch {
    if (Date.now() - lastRejectedLog >= 5000) {
      lastRejectedLog = Date.now();
      console.warn("[dolu_fivem_mcp] Rejected invalid execution log packet");
    }
  }
}
on(names.luaLog, (raw: unknown) => sendProgress(raw, "lua"));

onNet(names.execute, (raw: unknown) => {
  if (Number(source) !== 65535) {
    console.warn(
      "[dolu_fivem_mcp] Rejected execution not originating from the server",
    );
    return;
  }
  try {
    if (typeof raw !== "string" || raw.length > 270_000)
      throw new Error("Invalid execution envelope");
    const request = wireRequestSchema.parse(JSON.parse(raw));
    if (request.buildId !== BUILD_ID) {
      emitNet(
        names.result,
        request.id,
        encodeOutcome({
          ok: false,
          values: [],
          logs: [],
          durationMs: 0,
          error:
            "Server/client build mismatch; restart dolu_fivem_mcp and refresh the client.",
        }),
      );
      return;
    }
    if (pending.has(request.id)) throw new Error("Duplicate execution");
    if (pending.size >= 8) {
      emitNet(
        names.result,
        request.id,
        encodeOutcome({
          ok: false,
          values: [],
          logs: [],
          durationMs: 0,
          error: "Client execution limit reached (8 active executions).",
        }),
      );
      return;
    }
    pending.set(request.id, {
      language: request.language,
      seq: 0,
      deadline: Date.now() + request.timeoutMs,
      stop: scheduleTimeout(() => {
        executor.cancel(request.id);
        emit(names.luaCancel, request.id);
        sendResult(
          request.id,
          encodeOutcome({
            ok: false,
            values: [],
            logs: [],
            durationMs: request.timeoutMs,
            error: "Client execution deadline exceeded",
          }),
        );
      }, request.timeoutMs),
    });
    if (request.language === "lua") {
      emit(names.luaExecute, JSON.stringify(request));
    } else {
      void executor.execute(request).then(
        (outcome) => sendResult(request.id, encodeOutcome(outcome)),
        (error: unknown) =>
          sendResult(
            request.id,
            encodeOutcome({
              ok: false,
              values: [],
              logs: [],
              error: errorMessage(error),
              durationMs: 0,
            }),
          ),
      );
    }
  } catch (error) {
    console.error(`[dolu_fivem_mcp] ${errorMessage(error)}`);
  }
});

on(names.luaResult, (id: unknown, raw: unknown) => {
  if (typeof id !== "string" || pending.get(id)?.language !== "lua") return;
  try {
    if (typeof raw !== "string" || raw.length > MAX_RESULT)
      throw new Error("Invalid Lua result envelope");
    sendResult(id, encodeOutcome(outcomeSchema.parse(JSON.parse(raw))));
  } catch (error) {
    sendResult(
      id,
      encodeOutcome({
        ok: false,
        values: [],
        logs: [],
        error: errorMessage(error),
        durationMs: 0,
      }),
    );
  }
});

onNet(names.cancel, (id: unknown) => {
  if (Number(source) !== 65535 || typeof id !== "string") return;
  executor.cancel(id);
  emit(names.luaCancel, id);
  pending.get(id)?.stop();
  pending.delete(id);
});

RegisterNuiCallbackType("mcp_ready");
on("__cfx_nui:mcp_ready", (data: unknown, cb: (result: unknown) => void) => {
  const buildId =
    data && typeof data === "object" && "buildId" in data ? data.buildId : null;
  nuiBuildId =
    typeof buildId === "string" && buildId.length <= 128 ? buildId : null;
  nuiReady = nuiBuildId === BUILD_ID;
  cb({ ok: nuiReady, buildId: BUILD_ID });
  hello();
});
function hello(): void {
  emitNet(names.hello, {
    version: VERSION,
    buildId: BUILD_ID,
    nuiReady,
    nuiBuildId,
  });
}
const heartbeat = setInterval(hello, 5000);
hello();
on("onClientResourceStop", (name: string) => {
  if (name !== resource) return;
  clearInterval(heartbeat);
  executor.close();
  for (const [id, state] of pending) {
    state.stop();
    emit(names.luaCancel, id);
  }
  pending.clear();
});
