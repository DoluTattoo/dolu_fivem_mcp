import { get } from "node:http";
import { setTimeout, clearTimeout } from "node:timers";
import WebSocket from "ws";
import { z } from "zod";
import {
  FRAME_POINT,
  snapshotCode,
  nuiSnapshotSchema,
  interactionCode,
  prepareCode,
  nuiInteractionSchema,
  nuiWaitSchema,
  waitCode,
  type NuiInteraction,
  type NuiWait,
} from "./nui-dom";
import {
  NuiObservations,
  type NuiObservationOptions,
  nuiObservationReadSchema,
} from "./nui-observation";
export {
  nuiInteractionSchema,
  nuiWaitSchema,
  type NuiInteraction,
  type NuiWait,
} from "./nui-dom";
export {
  nuiObservationSchema,
  nuiObservationReadSchema,
  type NuiObservationOptions,
} from "./nui-observation";
import {
  CAPTURE_VERSION,
  type GameCaptureImage,
  type GameCaptureOptions,
} from "../shared/capture";

export const gameScreenshotOptionsSchema = z.object({
  includeNui: z.boolean().default(false),
  maxWidth: z.number().int().min(160).max(1920).default(1280),
  format: z.enum(["jpeg", "png"]).default("jpeg"),
  quality: z.number().min(0.1).max(1).default(0.85),
});
export type GameScreenshotOptions = z.output<
  typeof gameScreenshotOptionsSchema
>;
export interface GameScreenshot extends GameCaptureImage {
  includeNui: boolean;
  cefTargetId: string;
  cefCapturedAt?: string;
}

const captureImageSchema = z.object({
  data: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().positive().max(1920),
  height: z.number().int().positive().max(2160),
  capturedAt: z.iso.datetime(),
});
const viewportSchema = z.object({
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
});

export interface NuiFrame {
  resource: string | null;
  frameId: string;
  url: string;
  targetId: string;
}

export interface NuiDebuggerOptions {
  port: number;
  timeoutMs: number;
  maxResultBytes: number;
}

type ObjectValue = Record<string, unknown>;
type LocatedFrame = NuiFrame & { socketUrl: string; targetType: string };
type Pending = {
  resolve: (value: ObjectValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("NUI debugger operation timed out");
  return ms;
}

function pngData(response: ObjectValue): string {
  if (
    typeof response.data !== "string" ||
    !response.data.startsWith("iVBORw0KGgo") ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.data)
  ) {
    throw new Error("NUI screenshot did not return a base64 PNG");
  }
  return response.data;
}

function resourceFromUrl(url: string): string | null {
  // Preserve the resource's case; WHATWG URL lowercases hostname characters.
  const match = /^(nui|https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const resource =
    scheme === "nui"
      ? authority
      : authority.startsWith("cfx-nui-")
        ? authority.slice("cfx-nui-".length)
        : "";
  if (
    !/^[A-Za-z0-9_-]+$/.test(resource) ||
    (scheme === "nui" && resource.toLowerCase() === "game")
  ) {
    return null;
  }
  return resource;
}

class CdpConnection {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly contexts = new Map<string, number>();
  private readonly contextListeners = new Set<() => void>();
  private readonly eventListeners = new Set<
    (method: string, params: ObjectValue) => void
  >();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly allContexts = new Map<number, string>();
  private failure: Error | undefined;
  readonly ready: Promise<void>;

  constructor(
    url: string,
    private deadline: number,
    private readonly maxBytes: number,
  ) {
    this.socket = new WebSocket(url, {
      maxPayload: maxBytes,
      handshakeTimeout: remaining(deadline),
      followRedirects: false,
      perMessageDeflate: false,
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("NUI debugger connection timed out"));
      }, remaining(deadline));
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      this.socket.once("close", () => {
        clearTimeout(timer);
        reject(this.failure ?? new Error("NUI debugger disconnected"));
      });
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () =>
      this.fail(new Error("NUI debugger disconnected")),
    );
    this.socket.on("message", (data) => {
      try {
        const message = object(JSON.parse(data.toString()));
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(
              new Error(
                `NUI CDP error: ${String(object(message.error).message ?? "unknown error")}`,
              ),
            );
          } else {
            pending.resolve(object(message.result));
          }

          return;
        }
        const params = object(message.params);
        if (message.method === "Runtime.executionContextCreated") {
          const context = object(params.context);
          const aux = object(context.auxData);
          if (
            typeof context.id === "number" &&
            typeof aux.frameId === "string"
          ) {
            this.allContexts.set(context.id, aux.frameId);
            if (this.allContexts.size > 2048)
              throw new Error("Context limit exceeded");
          }
          if (
            aux.isDefault === true &&
            typeof aux.frameId === "string" &&
            typeof context.id === "number"
          ) {
            this.contexts.set(aux.frameId, context.id);
            if (this.contexts.size > 1024) {
              this.fail(new Error("NUI execution context limit exceeded"));
            }
          }
        } else if (message.method === "Runtime.executionContextDestroyed") {
          this.allContexts.delete(Number(params.executionContextId));
          for (const [frame, id] of this.contexts) {
            if (id === params.executionContextId) this.contexts.delete(frame);
          }
        } else if (message.method === "Runtime.executionContextsCleared") {
          this.contexts.clear();
          this.allContexts.clear();
        }
        for (const listener of this.contextListeners) listener();
        if (typeof message.method === "string")
          for (const listener of this.eventListeners)
            listener(message.method, params);
      } catch {
        this.fail(new Error("Invalid NUI CDP JSON response"));
      }
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.contextListeners) listener();
    for (const listener of this.failureListeners) listener(error);
    this.socket.terminate();
  }

  reuse(deadline: number): boolean {
    if (
      this.failure ||
      this.pending.size ||
      this.socket.readyState !== WebSocket.OPEN
    )
      return false;
    this.deadline = deadline;
    return true;
  }

  onEvent(listener: (method: string, params: ObjectValue) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  frameForContext(id: unknown): string | undefined {
    return typeof id === "number" ? this.allContexts.get(id) : undefined;
  }

  async call(method: string, params: ObjectValue = {}): Promise<ObjectValue> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending.size >= 32)
      throw new Error("Too many pending NUI CDP calls");
    const timeout = remaining(this.deadline);
    const id = ++this.nextId;
    const message = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(message) > this.maxBytes) {
      throw new Error("NUI CDP request exceeds maxResultBytes");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`NUI CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(message, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async context(frameId: string): Promise<number> {
    await this.call("Runtime.enable");
    const timeout = remaining(this.deadline);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.contextListeners.delete(check);
      };
      const check = () => {
        if (this.failure) {
          finish();
          reject(this.failure);
        } else {
          const id = this.contexts.get(frameId);
          if (id !== undefined) {
            finish();
            resolve(id);
          }
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(`NUI main-world context for frame ${frameId} timed out`),
        );
      }, timeout);
      this.contextListeners.add(check);
      check();
    });
  }

  close(): void {
    this.fail(new Error("NUI debugger connection closed"));
  }
}

async function evaluateContext(
  connection: CdpConnection,
  contextId: number,
  code: string,
): Promise<unknown> {
  const response = await connection.call("Runtime.evaluate", {
    expression: `(async function () {\n${code}\n}).call(globalThis)`,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const details = object(response.exceptionDetails);
    const exception = object(details.exception);
    throw new Error(
      `NUI evaluation failed: ${String(exception.description ?? details.text ?? "JavaScript exception")}`,
    );
  }
  const result = object(response.result);
  if ("value" in result) return result.value;
  if (typeof result.unserializableValue === "string")
    return result.unserializableValue;
  if (result.type === "undefined") return null;
  throw new Error("NUI evaluation result could not be serialized by value");
}

/**
 * Local CEF/NUI CDP adapter. NUI screenshots cover the selected Chromium target;
 * game screenshots use the bridge's WebGL capture, optionally with that overlay.
 */
export class NuiDebugger {
  private readonly endpoint: string;
  private readonly options: NuiDebuggerOptions;
  private readonly connections = new Set<CdpConnection>();
  private readonly idleConnections = new Map<
    string,
    {
      connection: CdpConnection;
      dispose: () => void;
    }
  >();
  private readonly abortHttp = new Set<() => void>();
  private closed = false;
  private capturingGame = false;
  private readonly observations: NuiObservations;
  private readonly snapshotRefs = new Set<string>();

  constructor(options: NuiDebuggerOptions) {
    if (
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535
    ) {
      throw new Error(
        "NUI debugger port must be an integer between 1 and 65535",
      );
    }
    for (const key of ["timeoutMs", "maxResultBytes"] as const) {
      if (!Number.isSafeInteger(options[key]) || options[key] <= 0) {
        throw new Error(`NUI debugger ${key} must be a positive safe integer`);
      }
      if (options.timeoutMs > 2147483647) {
        throw new Error("NUI debugger timeoutMs exceeds Node timer limit");
      }
    }
    this.options = { ...options };
    this.observations = new NuiObservations(
      Math.min(Math.floor(options.maxResultBytes / 2), 1024 * 1024),
    );
    this.endpoint = `http://127.0.0.1:${options.port}`;
  }

  private deadline(): number {
    if (this.closed) throw new Error("NUI debugger is closed");
    return Date.now() + this.options.timeoutMs;
  }

  private socketUrl(value: unknown): string {
    if (typeof value !== "string")
      throw new Error("Missing NUI target websocket URL");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid NUI target websocket URL");
    }
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port || "80") !== this.options.port ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error(
        "Unsafe NUI target websocket URL: expected configured loopback port",
      );
    }
    // Never resolve the target-supplied hostname, including 'localhost'.
    url.hostname = "127.0.0.1";
    return url.href;
  }

  private targets(deadline: number, signal?: AbortSignal): Promise<unknown[]> {
    signal?.throwIfAborted();
    if (this.abortHttp.size >= 16)
      throw new Error("Too many active NUI discovery requests");
    const timeout = remaining(deadline);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, value?: unknown[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.abortHttp.delete(abort);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const request = get(`${this.endpoint}/json/list`, (response) => {
        if (response.statusCode !== 200) {
          finish(
            new Error(
              `NUI discovery HTTP ${response.statusCode}; redirects are not allowed`,
            ),
          );
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.options.maxResultBytes) {
            finish(new Error("NUI discovery response exceeds maxResultBytes"));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(error));
        response.on("aborted", () =>
          finish(new Error("NUI discovery response aborted")),
        );
        response.on("end", () => {
          if (done) return;
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (!Array.isArray(value))
              throw new Error("NUI discovery expected a target array");
            if (value.length > 64)
              throw new Error("NUI discovery exceeds 64 target limit");
            finish(undefined, value);
          } catch (error) {
            finish(
              error instanceof Error
                ? error
                : new Error("Invalid NUI discovery JSON"),
            );
          }
        });
      });
      const abort = () => {
        const error = new Error(
          signal?.aborted ? "NUI wait aborted" : "NUI debugger is closed",
        );
        finish(error);
        request.destroy(error);
      };
      const timer = setTimeout(() => {
        const error = new Error("NUI discovery timed out");
        finish(error);
        request.destroy(error);
      }, timeout);
      this.abortHttp.add(abort);
      signal?.addEventListener("abort", abort, { once: true });
      request.on("error", (error) => finish(error));
    });
  }

  private async connect<T>(
    socketUrl: string,
    deadline: number,
    action: (connection: CdpConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("NUI debugger is closed");
    if (this.connections.size >= 16)
      throw new Error("Too many active NUI connections");
    const idle = this.idleConnections.get(socketUrl);
    idle?.dispose();
    const connection = idle?.connection.reuse(deadline)
      ? idle.connection
      : new CdpConnection(socketUrl, deadline, this.options.maxResultBytes);
    if (idle && idle.connection !== connection) idle.connection.close();
    this.connections.add(connection);
    const abort = () => connection.close();
    signal?.addEventListener("abort", abort, { once: true });
    let succeeded = false;
    try {
      await connection.ready;
      const result = await action(connection);
      succeeded = true;
      return result;
    } finally {
      this.connections.delete(connection);
      signal?.removeEventListener("abort", abort);
      if (
        succeeded &&
        !this.closed &&
        !signal?.aborted &&
        connection.reuse(deadline) &&
        this.idleConnections.size < 4 &&
        !this.idleConnections.has(socketUrl)
      ) {
        let offFailure = () => {};
        const dispose = () => {
          clearTimeout(timer);
          offFailure();
          this.idleConnections.delete(socketUrl);
        };
        const timer = setTimeout(() => {
          dispose();
          connection.close();
        }, 2000);
        this.idleConnections.set(socketUrl, { connection, dispose });
        offFailure = connection.onFailure(dispose);
      } else connection.close();
    }
  }

  private async discover(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<LocatedFrame[]> {
    const targets = await this.targets(deadline, signal);
    const frames: LocatedFrame[] = [];
    const seen = new Set<string>();
    for (const entry of targets) {
      const target = object(entry);
      if (!["page", "iframe", "webview"].includes(String(target.type)))
        continue;
      if (typeof target.id !== "string")
        throw new Error("NUI target is missing an id");
      const targetId = target.id;
      const socketUrl = this.socketUrl(target.webSocketDebuggerUrl);
      await this.connect(
        socketUrl,
        deadline,
        async (connection) => {
          const tree = await connection.call("Page.getFrameTree");
          const stack: Array<{ tree: unknown; parentResource: string | null }> =
            [{ tree: tree.frameTree, parentResource: null }];
          let count = 0;
          while (stack.length) {
            if (++count > 1024)
              throw new Error("NUI discovery exceeds frame limit");
            const entry = stack.pop()!;
            const branch = object(entry.tree);
            const frame = object(branch.frame);
            if (typeof frame.id !== "string" || typeof frame.url !== "string") {
              throw new Error("Invalid NUI CDP frame tree");
            }
            const resource =
              resourceFromUrl(frame.url) ??
              (["about:blank", "about:srcdoc"].includes(frame.url)
                ? entry.parentResource
                : null);
            const key = JSON.stringify([targetId, frame.id]);
            if (!seen.has(key)) {
              seen.add(key);
              frames.push({
                resource,
                frameId: frame.id,
                url: frame.url,
                targetId,
                socketUrl,
                targetType: String(target.type),
              });
            }
            if (Array.isArray(branch.childFrames))
              stack.push(
                ...branch.childFrames.map((tree) => ({
                  tree,
                  parentResource: resource,
                })),
              );
          }
        },
        signal,
      );
    }
    return frames;
  }

  async frames(): Promise<NuiFrame[]> {
    const frames = (await this.discover(this.deadline())).map(
      ({ resource, frameId, url, targetId }) => ({
        resource,
        frameId,
        url,
        targetId,
      }),
    );
    if (
      Buffer.byteLength(JSON.stringify(frames)) > this.options.maxResultBytes
    ) {
      throw new Error("NUI frame listing exceeds maxResultBytes");
    }
    return frames;
  }

  private async withFrame<T>(
    resource: string,
    frameId: string | undefined,
    action: (
      connection: CdpConnection,
      frame: LocatedFrame,
      deadline: number,
    ) => Promise<T>,
    deadline = this.deadline(),
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!resource) throw new Error("A NUI resource name is required");
    const matches = (await this.discover(deadline, signal)).filter(
      (frame) =>
        frame.resource === resource &&
        (frameId === undefined || frame.frameId === frameId),
    );
    if (!matches.length) {
      throw new Error(
        `NUI frame not found for resource ${resource}${frameId ? ` (${frameId})` : ""}`,
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `Ambiguous NUI frames for resource ${resource}; specify a unique frameId`,
      );
    }
    const frame = matches[0]!;
    return this.connect(
      frame.socketUrl,
      deadline,
      (connection) => action(connection, frame, deadline),
      signal,
    );
  }

  async evaluate(
    resource: string,
    code: string,
    frameId?: string,
  ): Promise<unknown> {
    return this.withFrame(resource, frameId, async (connection, frame) => {
      const contextId = await connection.context(frame.frameId);
      return evaluateContext(connection, contextId, code);
    });
  }

  async gameScreenshot(
    resource: string,
    input: GameScreenshotOptions,
  ): Promise<GameScreenshot> {
    const options = gameScreenshotOptionsSchema.parse(input);
    if (this.capturingGame)
      throw new Error("A game screenshot is already active");
    this.capturingGame = true;
    try {
      return await this.withFrame(
        resource,
        undefined,
        async (connection, frame, deadline) => {
          const contextId = await connection.context(frame.frameId);
          const viewport = viewportSchema.parse(
            await evaluateContext(
              connection,
              contextId,
              `if (globalThis.doluMcpCapture?.version !== ${CAPTURE_VERSION}) {
  throw new Error('Game capture bridge unavailable; build and restart dolu_fivem_mcp from the server console');
}
return { width: innerWidth, height: innerHeight };`,
            ),
          );
          let overlay: string | undefined;
          let cefCapturedAt: string | undefined;
          if (options.includeNui) {
            const tree = await connection.call("Page.getFrameTree");
            const root = object(object(tree.frameTree).frame);
            if (root.url !== "nui://game/ui/root.html") {
              throw new Error(
                "Game + NUI capture requires the main FiveM CEF root target",
              );
            }
            const scale = Math.min(
              1,
              options.maxWidth / viewport.width,
              2160 / viewport.height,
            );
            overlay = pngData(
              await connection.call("Page.captureScreenshot", {
                format: "png",
                fromSurface: true,
                captureBeyondViewport: false,
                clip: {
                  x: 0,
                  y: 0,
                  width: viewport.width,
                  height: viewport.height,
                  scale,
                },
              }),
            );
            cefCapturedAt = new Date().toISOString();
          }
          // Leave room for the CDP envelope and the injected capture arguments.
          const maxBytes = Math.floor(
            (this.options.maxResultBytes - 16_384) * 0.75,
          );
          if (maxBytes <= 0)
            throw new Error("Game capture byte budget is too small");
          const captureOptions: GameCaptureOptions = {
            maxWidth: options.maxWidth,
            format: options.format,
            quality: options.quality,
            timeoutMs: remaining(deadline),
            maxBytes,
            overlay,
          };
          const image = captureImageSchema.parse(
            await evaluateContext(
              connection,
              contextId,
              `return await globalThis.doluMcpCapture.capture(${JSON.stringify(captureOptions)});`,
            ),
          );
          const expectedMime = `image/${options.format}`;
          const signature = options.format === "png" ? "iVBORw0KGgo" : "/9j/";
          if (
            image.mimeType !== expectedMime ||
            !image.data.startsWith(signature) ||
            image.data.length % 4 !== 0 ||
            image.width > options.maxWidth ||
            Buffer.from(image.data, "base64").byteLength > maxBytes
          ) {
            throw new Error("Invalid or oversized game screenshot result");
          }
          return {
            ...image,
            includeNui: options.includeNui,
            cefTargetId: frame.targetId,
            cefCapturedAt,
          };
        },
      );
    } finally {
      this.capturingGame = false;
    }
  }

  async snapshot(
    resource: string,
    frameId?: string,
    options: z.input<typeof nuiSnapshotSchema> = {},
  ): Promise<unknown> {
    const result = await this.evaluate(
      resource,
      snapshotCode(options),
      frameId,
    );
    for (const element of Array.isArray(object(result).elements)
      ? (object(result).elements as unknown[])
      : []) {
      const ref = object(element).ref;
      if (typeof ref !== "string") continue;
      if (this.snapshotRefs.size >= 500 && !this.snapshotRefs.has(ref))
        this.snapshotRefs.delete(this.snapshotRefs.values().next().value!);
      this.snapshotRefs.add(ref);
    }
    return result;
  }

  async bridgeStatus(resource: string, frameId?: string) {
    return z
      .object({
        buildId: z.string().max(200).nullable(),
        captureVersion: z.number().int().nullable(),
        captureAvailable: z.boolean(),
        documentReadyState: z.enum(["loading", "interactive", "complete"]),
      })
      .parse(
        await this.evaluate(
          resource,
          `
var descriptor = Object.getOwnPropertyDescriptor(globalThis, 'doluMcpCapture');
var bridge = descriptor && descriptor.value;
var build = Object.getOwnPropertyDescriptor(globalThis, 'doluMcpBuild');
var version = bridge && Object.getOwnPropertyDescriptor(bridge, 'version');
var capture = bridge && Object.getOwnPropertyDescriptor(bridge, 'capture');
return {
  buildId: build && typeof build.value === 'string' ? build.value.slice(0,200) : null,
  captureVersion: version && Number.isInteger(version.value) ? version.value : null,
  captureAvailable: !!capture && typeof capture.value === 'function',
  documentReadyState: document.readyState
};`,
          frameId,
        ),
      );
  }

  async click(
    resource: string,
    selector: string,
    frameId?: string,
  ): Promise<unknown> {
    if (!selector) throw new Error("A nonempty NUI CSS selector is required");
    await this.interact(
      resource,
      { action: "click", selector, mode: "dom" },
      frameId,
    );
    return { clicked: true, selector };
  }

  private async inputPoint(
    connection: CdpConnection,
    frame: LocatedFrame,
    position: ObjectValue,
  ): Promise<ObjectValue> {
    if (frame.targetType === "iframe")
      throw new Error(
        "CDP input into a separate iframe target is unsupported; use DOM mode",
      );
    const tree = await connection.call("Page.getFrameTree");
    const parents = new Map<string, string>();
    const root = object(object(tree.frameTree).frame);
    const pending = [object(tree.frameTree)];
    let visited = 0;
    while (pending.length) {
      if (++visited > 1024) throw new Error("NUI frame limit exceeded");
      const branch = pending.pop()!;
      for (const child of Array.isArray(branch.childFrames)
        ? branch.childFrames
        : []) {
        const item = object(child);
        parents.set(
          String(object(item.frame).id),
          String(object(branch.frame).id),
        );
        pending.push(item);
      }
    }
    let id = frame.frameId;
    while (id !== root.id) {
      const parent = parents.get(id);
      if (!parent)
        throw new Error("NUI frame ancestry changed; input canceled");
      const owner = await connection.call("DOM.getFrameOwner", { frameId: id });
      const resolved = await connection.call("DOM.resolveNode", {
        backendNodeId: owner.backendNodeId,
        executionContextId: await connection.context(parent),
      });
      const objectId = object(resolved.object).objectId;
      if (typeof objectId !== "string")
        throw new Error("NUI frame owner unavailable");
      try {
        const result = await connection.call("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: FRAME_POINT,
          arguments: [{ value: position }],
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            "NUI iframe is hidden, clipped, transformed, detached or obscured; input canceled",
          );
        position = object(object(result.result).value);
      } finally {
        await connection.call("Runtime.releaseObject", { objectId });
      }
      id = parent;
    }
    if (
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    )
      throw new Error("Invalid NUI input coordinates");
    return position;
  }

  async interact(
    resource: string,
    input: NuiInteraction,
    frameId?: string,
  ): Promise<unknown> {
    const args = nuiInteractionSchema.parse(input);
    if (args.ref && !this.snapshotRefs.has(args.ref))
      throw new Error("Stale or unknown NUI snapshot ref; take a new snapshot");
    return this.withFrame(resource, frameId, async (connection, frame) => {
      const contextId = await connection.context(frame.frameId);
      const prepared = object(
        await evaluateContext(connection, contextId, prepareCode(args)),
      );
      const position = await this.inputPoint(connection, frame, prepared);
      if (typeof prepared.ref !== "string")
        throw new Error("NUI element preparation failed");
      const result = await evaluateContext(
        connection,
        contextId,
        interactionCode({ ...args, selector: undefined, ref: prepared.ref }),
      );
      if (
        (args.action === "click" && args.mode === "dom") ||
        args.action === "select"
      )
        return result;
      const current = object(result);
      if (
        ["x", "y", "width", "height"].some(
          (key) => current[key] !== prepared[key],
        )
      )
        throw new Error("NUI element moved during preparation; input canceled");
      const { x, y } = position;
      if (args.action === "fill") {
        if (args.text)
          await connection.call("Input.insertText", { text: args.text });
        else {
          await connection.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          });
          await connection.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          });
        }
      } else if (args.action === "key") {
        const keys: Record<string, [string, string, number]> = {
          Enter: ["Enter", "Enter", 13],
          Tab: ["Tab", "Tab", 9],
          Escape: ["Escape", "Escape", 27],
          Backspace: ["Backspace", "Backspace", 8],
          Delete: ["Delete", "Delete", 46],
          ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
          ArrowUp: ["ArrowUp", "ArrowUp", 38],
          ArrowRight: ["ArrowRight", "ArrowRight", 39],
          ArrowDown: ["ArrowDown", "ArrowDown", 40],
          Home: ["Home", "Home", 36],
          End: ["End", "End", 35],
          PageUp: ["PageUp", "PageUp", 33],
          PageDown: ["PageDown", "PageDown", 34],
          Space: [" ", "Space", 32],
          a: ["a", "KeyA", 65],
        };
        const [baseKey, code, windowsVirtualKeyCode] = keys[args.key]!;
        const masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
        const modifiers = args.modifiers.reduce(
          (mask, modifier) => mask | masks[modifier],
          0,
        );
        const key = args.key === "a" && modifiers & 8 ? "A" : baseKey;
        const keyParams = { key, code, windowsVirtualKeyCode, modifiers };
        await connection.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          ...keyParams,
          ...(!(modifiers & 7) && ["Enter", "Space", "a"].includes(args.key)
            ? { text: args.key === "Enter" ? "\r" : key }
            : {}),
        });
        await connection.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          ...keyParams,
        });
      } else if (args.action === "click") {
        await connection.call("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await connection.call("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      } else if (args.action === "hover") {
        await connection.call("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
        });
      } else {
        await connection.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: args.deltaX,
          deltaY: args.deltaY,
        });
      }
      return { action: args.action, dispatched: true, mode: "cdp" };
    });
  }

  async waitFor(
    resource: string,
    input: NuiWait,
    frameId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = nuiWaitSchema.parse(input);
    if (args.ref && !this.snapshotRefs.has(args.ref))
      throw new Error("Stale or unknown NUI snapshot ref; take a new snapshot");
    if (this.closed) throw new Error("NUI debugger is closed");
    const deadline = Date.now() + args.timeoutMs;
    return this.withFrame(
      resource,
      frameId,
      async (connection, frame) => {
        const contextId = await connection.context(frame.frameId);
        for (;;) {
          signal?.throwIfAborted();
          remaining(deadline);
          const result = object(
            await evaluateContext(connection, contextId, waitCode(args)),
          );
          remaining(deadline);
          if (result.matched === true)
            return { ...result, resource, frameId: frame.frameId };
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              signal?.removeEventListener("abort", abort);
              resolve();
            };
            const timer = setTimeout(
              finish,
              Math.min(100, remaining(deadline)),
            );
            const abort = () => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              reject(new Error("NUI wait aborted"));
            };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
      },
      deadline,
      signal,
    );
  }

  async startObservation(
    resource: string,
    input: NuiObservationOptions = {},
    frameId?: string,
    guard?: () => Promise<unknown>,
  ) {
    const deadline = this.deadline();
    await guard?.();
    const matches = (await this.discover(deadline)).filter(
      (frame) =>
        frame.resource === resource &&
        (frameId === undefined || frame.frameId === frameId),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? "Ambiguous NUI frames; specify frameId"
          : "NUI frame not found",
      );
    if (this.closed) throw new Error("NUI debugger is closed");
    if (this.connections.size >= 16)
      throw new Error("Too many active NUI connections");
    const frame = matches[0]!;
    const connection = new CdpConnection(
      frame.socketUrl,
      deadline,
      this.options.maxResultBytes,
    );
    this.connections.add(connection);
    try {
      await connection.ready;
      return await this.observations.start(
        connection,
        frame,
        input,
        guard,
        () => this.connections.delete(connection),
      );
    } catch (error) {
      this.connections.delete(connection);
      connection.close();
      throw error;
    }
  }

  readObservation(
    id: string,
    options: z.input<typeof nuiObservationReadSchema> = {},
  ) {
    return this.observations.read(id, options);
  }

  stopObservation(id: string) {
    return this.observations.stop(id);
  }

  listObservations() {
    return this.observations.list();
  }

  /** Base64 PNG of the whole selected target; includes other NUI frames in it. */
  async screenshot(resource: string, frameId?: string): Promise<string> {
    return this.withFrame(resource, frameId, async (connection) => {
      const response = await connection.call("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      return pngData(response);
    });
  }

  close(): void {
    this.closed = true;
    this.snapshotRefs.clear();
    this.observations.close();
    for (const abort of this.abortHttp) abort();
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    for (const idle of [...this.idleConnections.values()]) {
      idle.dispose();
      idle.connection.close();
    }
  }
}
