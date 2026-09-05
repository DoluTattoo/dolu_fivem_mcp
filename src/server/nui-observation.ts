import { randomUUID } from "node:crypto";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import { z } from "zod";

export const nuiObservationSchema = z.object({
  durationMs: z.number().int().min(1).max(60000).default(10000),
  maxEntries: z.number().int().min(1).max(500).default(200),
  console: z.boolean().default(true),
  exceptions: z.boolean().default(true),
  network: z.boolean().default(false),
  playerId: z.number().int().positive().optional(),
});
export type NuiObservationOptions = z.input<typeof nuiObservationSchema>;
export const nuiObservationReadSchema = z.object({
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
type Value = Record<string, unknown>;
export interface ObservationConnection {
  call(method: string, params?: Value): Promise<Value>;
  context(frameId: string): Promise<number>;
  onEvent(listener: (method: string, params: Value) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  frameForContext(id: unknown): string | undefined;
  close(): void;
}
interface Entry {
  cursor: number;
  time: string;
  kind: string;
  attribution: "selected-frame";
  resource: string;
  frameId: string;
  targetId: string;
  data: Value;
}
interface Session {
  id: string;
  resource: string;
  frameId: string;
  targetId: string;
  playerId?: number;
  startedAt: number;
  expiresAt: number;
  endedAt?: number;
  status: "active" | "stopped" | "expired" | "disconnected" | "revoked";
  error?: string;
  options: z.output<typeof nuiObservationSchema>;
  entries: Entry[];
  bytes: number;
  next: number;
  dropped: number;
  skipped: number;
  guard?: () => Promise<unknown>;
  checking: boolean;
  connection: ObservationConnection;
  cleanup: Array<() => void>;
}
const obj = (value: unknown): Value =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Value)
    : {};

function url(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:", "nui:", "ws:", "wss:", "file:"].includes(
        parsed.protocol,
      )
    )
      return "[redacted URL]";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.slice(0, 1000);
  } catch {
    return "[invalid URL]";
  }
}
function text(value: unknown, length = 2000): string {
  return String(value ?? "")
    .replace(/\b(?:https?|nui|wss?|file|data|blob):[^\s"'<>]+/gi, (match) =>
      url(match),
    )
    .slice(0, length);
}
function stack(value: unknown, depth = 0): Value | undefined {
  if (!value || depth >= 3) return undefined;
  const source = obj(value);
  return {
    callFrames: (Array.isArray(source.callFrames) ? source.callFrames : [])
      .slice(0, 20)
      .map((frame) => {
        const f = obj(frame);
        return {
          functionName: text(f.functionName, 200),
          url: url(f.url),
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber,
        };
      }),
    parent: stack(source.parent, depth + 1),
  };
}
function argument(value: unknown): Value {
  const remote = obj(value);
  // Never request properties, invoke getters, retain object IDs, or include
  // previews/descriptions of objects (DOM nodes may contain private input data).
  const result: Value = { type: text(remote.type, 40) };
  if (typeof remote.subtype === "string")
    result.subtype = text(remote.subtype, 40);
  if (
    ["string", "number", "boolean"].includes(String(remote.type)) &&
    ["string", "number", "boolean"].includes(typeof remote.value)
  )
    result.value =
      typeof remote.value === "string" ? text(remote.value) : remote.value;
  if (remote.subtype === "null") result.value = null;
  return result;
}

export class NuiObservations {
  private readonly sessions = new Map<string, Session>();
  private sweep?: ReturnType<typeof setInterval>;
  constructor(private readonly maxBytes: number) {}

  private finish(
    session: Session,
    status: Session["status"],
    error?: string,
  ): void {
    if (session.status !== "active") return;
    session.status = status;
    session.error = error;
    session.endedAt = Date.now();
    for (const cleanup of session.cleanup.splice(0)) cleanup();
    session.connection.close();
    this.prune();
  }
  private prune(): void {
    const ended = [...this.sessions.values()].filter(
      (s) => s.status !== "active",
    );
    for (const session of ended) {
      if (
        Date.now() - session.endedAt! > 60000 ||
        ended.indexOf(session) < ended.length - 20
      )
        this.sessions.delete(session.id);
    }
    if (!this.sessions.size && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
  }
  private async authorize(session: Session): Promise<void> {
    try {
      await session.guard?.();
    } catch {
      this.finish(session, "revoked", "NUI observation authorization revoked");
      session.entries = [];
      session.bytes = 0;
      throw new Error("NUI observation authorization revoked");
    }
    if (session.status === "revoked")
      throw new Error("NUI observation authorization revoked");
  }
  private tick(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      if (Date.now() >= session.expiresAt) {
        this.finish(session, "expired");
        continue;
      }
      if (session.checking) continue;
      session.checking = true;
      void this.authorize(session)
        .catch(() => undefined)
        .finally(() => {
          session.checking = false;
        });
    }
    this.prune();
  }
  private summary(session: Session) {
    return {
      id: session.id,
      resource: session.resource,
      frameId: session.frameId,
      targetId: session.targetId,
      playerId: session.playerId,
      startedAt: new Date(session.startedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      status: session.status,
      error: session.error,
      count: session.entries.length,
      bytes: session.bytes,
      dropped: session.dropped,
      skipped: session.skipped,
      truncated: session.dropped > 0,
      firstCursor: session.entries[0]?.cursor ?? session.next,
      nextCursor: session.next,
      semantics:
        "from-start; pre-start Runtime timestamps and unattributable events omitted; no response bodies/headers",
    };
  }
  async start(
    connection: ObservationConnection,
    frame: { resource: string | null; frameId: string; targetId: string },
    input: NuiObservationOptions,
    guard?: () => Promise<unknown>,
    release?: () => void,
  ) {
    if (
      [...this.sessions.values()].filter((s) => s.status === "active").length >=
      8
    )
      throw new Error("NUI observation session limit exceeded");
    const options = nuiObservationSchema.parse(input);
    await guard?.();
    if (
      [...this.sessions.values()].filter((s) => s.status === "active").length >=
      8
    )
      throw new Error("NUI observation session limit exceeded");
    const startedAt = Date.now();
    const session: Session = {
      id: randomUUID(),
      resource: frame.resource!,
      frameId: frame.frameId,
      targetId: frame.targetId,
      playerId: options.playerId,
      startedAt,
      expiresAt: startedAt + options.durationMs,
      status: "active",
      options,
      entries: [],
      bytes: 0,
      next: 0,
      dropped: 0,
      skipped: 0,
      guard,
      checking: false,
      connection,
      cleanup: release ? [release] : [],
    };
    const requests = new Map<string, { url: string; method: string }>();
    let selectedContext: number | undefined;
    const add = (kind: string, data: Value) => {
      if (session.status !== "active" || Date.now() >= session.expiresAt)
        return;
      const entry: Entry = {
        cursor: session.next++,
        time: new Date().toISOString(),
        kind,
        attribution: "selected-frame",
        resource: session.resource,
        frameId: session.frameId,
        targetId: session.targetId,
        data,
      };
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (bytes > this.maxBytes) {
        session.dropped++;
        return;
      }
      while (
        session.entries.length >= options.maxEntries ||
        session.bytes + bytes > this.maxBytes
      ) {
        session.bytes -= Buffer.byteLength(
          JSON.stringify(session.entries.shift()!),
        );
        session.dropped++;
      }
      session.entries.push(entry);
      session.bytes += bytes;
    };
    session.cleanup.push(
      connection.onEvent((method, params) => {
        if (session.status !== "active") return;
        if (method === "Runtime.executionContextCreated") {
          const context = obj(params.context),
            aux = obj(context.auxData);
          if (
            aux.isDefault === true &&
            aux.frameId === frame.frameId &&
            typeof context.id === "number"
          )
            selectedContext = context.id;
        } else if (
          method === "Runtime.executionContextDestroyed" &&
          params.executionContextId === selectedContext
        ) {
          this.finish(
            session,
            "disconnected",
            "Observed document context was destroyed",
          );
          return;
        }
        if (method === "Runtime.consoleAPICalled" && options.console) {
          if (
            connection.frameForContext(params.executionContextId) !==
              frame.frameId ||
            typeof params.timestamp !== "number" ||
            params.timestamp < startedAt
          ) {
            session.skipped++;
            return;
          }
          add("console", {
            type: text(params.type, 40),
            args: (Array.isArray(params.args) ? params.args : [])
              .slice(0, 20)
              .map(argument),
            stack: stack(params.stackTrace),
            contextId: params.executionContextId,
          });
        } else if (method === "Runtime.exceptionThrown" && options.exceptions) {
          const details = obj(params.exceptionDetails);
          if (
            connection.frameForContext(details.executionContextId) !==
              frame.frameId ||
            typeof params.timestamp !== "number" ||
            params.timestamp < startedAt
          ) {
            session.skipped++;
            return;
          }
          add("exception", {
            text: text(details.text),
            exception: argument(details.exception),
            message:
              obj(details.exception).subtype === "error"
                ? text(obj(details.exception).description)
                : undefined,
            url: url(details.url),
            lineNumber: details.lineNumber,
            columnNumber: details.columnNumber,
            stack: stack(details.stackTrace),
            contextId: details.executionContextId,
          });
        } else if (options.network && method === "Network.requestWillBeSent") {
          if (
            typeof params.requestId !== "string" ||
            params.requestId.length > 200
          ) {
            session.skipped++;
            return;
          }
          const id = String(params.requestId);
          if (params.frameId !== frame.frameId) {
            requests.delete(id);
            session.skipped++;
            return;
          }
          const req = obj(params.request);
          const metadata = { url: url(req.url), method: text(req.method, 20) };
          if (requests.size >= 500)
            requests.delete(requests.keys().next().value!);
          requests.set(id, metadata);
          add("network.request", {
            requestId: id,
            ...metadata,
            type: text(params.type, 40),
          });
        } else if (
          options.network &&
          [
            "Network.responseReceived",
            "Network.loadingFailed",
            "Network.loadingFinished",
          ].includes(method)
        ) {
          if (
            typeof params.requestId !== "string" ||
            params.requestId.length > 200
          ) {
            session.skipped++;
            return;
          }
          const id = String(params.requestId),
            request = requests.get(id);
          if (
            !request ||
            (params.frameId !== undefined && params.frameId !== frame.frameId)
          ) {
            session.skipped++;
            return;
          }
          if (method === "Network.responseReceived") {
            const response = obj(params.response);
            add("network.response", {
              requestId: id,
              url: url(response.url),
              status: response.status,
              mimeType: text(response.mimeType, 100),
              fromDiskCache: response.fromDiskCache === true,
            });
          } else {
            if (method === "Network.loadingFailed")
              add("network.failed", {
                requestId: id,
                ...request,
                errorText: text(params.errorText),
                canceled: params.canceled === true,
              });
            requests.delete(id);
          }
        } else if (
          method === "Runtime.executionContextsCleared" ||
          (method === "Page.frameNavigated" &&
            obj(params.frame).id === frame.frameId) ||
          (method === "Page.frameDetached" && params.frameId === frame.frameId)
        ) {
          this.finish(
            session,
            "disconnected",
            "Observed document navigated or detached; start a new observation",
          );
        }
      }),
      connection.onFailure((error) =>
        this.finish(session, "disconnected", text(error.message)),
      ),
    );
    this.sessions.set(session.id, session);
    const timer = setTimeout(
      () => this.finish(session, "expired"),
      options.durationMs,
    );
    timer.unref();
    session.cleanup.push(() => clearTimeout(timer));
    if (!this.sweep) {
      this.sweep = setInterval(() => this.tick(), 1000);
      this.sweep.unref();
    }
    try {
      // Listeners precede enable: buffered Runtime events are filtered by timestamp.
      selectedContext = await connection.context(frame.frameId);
      await connection.call("Page.enable");
      if (options.network)
        await connection.call("Network.enable", {
          maxTotalBufferSize: 0,
          maxResourceBufferSize: 0,
          maxPostDataSize: 0,
        });
      if (session.status !== "active")
        throw new Error(
          session.error ?? "Observation ended during initialization",
        );
      return this.summary(session);
    } catch (error) {
      this.finish(
        session,
        "disconnected",
        error instanceof Error ? error.message : "Observation failed",
      );
      throw error;
    }
  }
  private get(id: string): Session {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown or expired NUI observation");
    return session;
  }
  async read(id: string, input: z.input<typeof nuiObservationReadSchema> = {}) {
    const { cursor, limit } = nuiObservationReadSchema.parse(input);
    const session = this.get(id);
    await this.authorize(session);
    if (session.status === "active" && Date.now() >= session.expiresAt)
      this.finish(session, "expired");
    const entries = session.entries
      .filter((e) => e.cursor >= cursor)
      .slice(0, limit);
    return {
      ...this.summary(session),
      entries,
      cursor:
        entries.at(-1) !== undefined
          ? entries.at(-1)!.cursor + 1
          : Math.max(cursor, session.next),
      cursorDropped: Math.max(
        0,
        (session.entries[0]?.cursor ?? session.next) - cursor,
      ),
    };
  }
  async stop(id: string) {
    const session = this.get(id);
    await this.authorize(session);
    this.finish(session, "stopped");
    return this.summary(session);
  }
  async list() {
    this.prune();
    const result = [];
    for (const session of this.sessions.values()) {
      try {
        await this.authorize(session);
        result.push(this.summary(session));
      } catch {
        /* Omit inaccessible sessions. */
      }
    }
    return result;
  }
  close(): void {
    for (const session of this.sessions.values())
      this.finish(session, "disconnected", "NUI debugger closed");
    this.sessions.clear();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
  }
}
