import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { NuiDebugger } from "../src/server/nui";
import type { GameCaptureOptions } from "../src/shared/capture";
import { domFixture } from "./nui-dom-fixture";

type FrameTree = {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
};
type Target = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};
type Command = { id: number; method: string; params: Record<string, unknown> };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeDebugger() {
  const wss = new WebSocketServer({ noServer: true });
  const state = {
    targets: [] as Target[],
    trees: new Map<string, FrameTree>(),
    commands: [] as Command[],
    requests: [] as string[],
    connections: 0,
    contexts: true,
    delayedContexts: false,
    evaluate: undefined as
      | ((params: Record<string, unknown>) => unknown | Promise<unknown>)
      | undefined,
    intercept: undefined as
      ((command: Command, socket: WebSocket) => boolean) | undefined,
    http: undefined as ((response: ServerResponse) => void) | undefined,
  };
  const server = createServer((request, response) => {
    state.requests.push(request.url ?? "");
    if (state.http) return state.http(response);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(state.targets));
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      state.connections++;
      const targetId = request.url!.split("/").at(-1)!;
      ws.on("error", () => undefined);
      ws.on("message", (data) => {
        void (async () => {
          const command = JSON.parse(data.toString()) as Command;
          state.commands.push(command);
          if (state.intercept?.(command, ws)) return;
          const respond = (result: unknown) =>
            ws.send(JSON.stringify({ id: command.id, result }));
          const tree = state.trees.get(targetId)!;
          if (command.method === "Page.getFrameTree") {
            respond({ frameTree: tree });
          } else if (command.method === "Runtime.enable") {
            const sendContexts = () => {
              if (!state.contexts || ws.readyState !== WebSocket.OPEN) return;
              const stack = [tree];
              let contextId = 10;
              while (stack.length) {
                const frame = stack.pop()!;
                for (const isDefault of [false, true]) {
                  ws.send(
                    JSON.stringify({
                      method: "Runtime.executionContextCreated",
                      params: {
                        context: {
                          id: contextId++,
                          auxData: { frameId: frame.frame.id, isDefault },
                        },
                      },
                    }),
                  );
                }
                stack.push(...(frame.childFrames ?? []));
              }
            };
            if (!state.delayedContexts) sendContexts();
            respond({});
            if (state.delayedContexts) setTimeout(sendContexts, 5);
          } else if (command.method === "Runtime.evaluate") {
            try {
              const value = state.evaluate
                ? await state.evaluate(command.params)
                : { contextId: command.params.contextId };
              respond({ result: { type: "object", value } });
            } catch (error) {
              respond({
                exceptionDetails: {
                  text: "Uncaught",
                  exception: { description: String(error) },
                },
              });
            }
          } else if (command.method === "Page.captureScreenshot") {
            respond({ data: "iVBORw0KGgoAAAANSUhEUg==" });
          } else if (command.method === "DOM.getFrameOwner") {
            respond({ backendNodeId: 123 });
          } else if (command.method === "DOM.resolveNode") {
            respond({ object: { objectId: "iframe-owner" } });
          } else if (command.method === "Runtime.callFunctionOn") {
            const position = (
              command.params.arguments as Array<{
                value: Record<string, number>;
              }>
            )[0]!.value;
            respond({
              result: {
                value: {
                  ...position,
                  x: position.x! + 100,
                  y: position.y! + 50,
                },
              },
            });
          } else if (
            ["Runtime.releaseObject", "Page.enable", "Network.enable"].includes(
              command.method,
            ) ||
            command.method.startsWith("Input.")
          ) {
            respond({});
          } else {
            ws.send(
              JSON.stringify({
                id: command.id,
                error: { message: "Unsupported command" },
              }),
            );
          }
        })().catch(() => ws.terminate());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const addTarget = (id: string, tree: FrameTree) => {
    state.trees.set(id, tree);
    state.targets.push({
      id,
      type: "page",
      url: tree.frame.url,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
    });
  };
  addTarget("root", {
    frame: { id: "root-frame", url: "nui://game/ui/root.html" },
    childFrames: [
      {
        frame: {
          id: "resource-frame",
          url: "https://cfx-nui-My-Hud_test/ui/index.html",
        },
        childFrames: [
          {
            frame: {
              id: "external-frame",
              url: "https://example.com/My-Hud_test",
            },
          },
        ],
      },
    ],
  });
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const adapter = (
    options: { timeoutMs?: number; maxResultBytes?: number } = {},
  ) => {
    const instance = new NuiDebugger({
      port,
      timeoutMs: options.timeoutMs ?? 2000,
      maxResultBytes: options.maxResultBytes ?? 65536,
    });
    cleanups.push(() => instance.close());
    return instance;
  };
  return { state, port, addTarget, adapter, wss };
}

describe("NuiDebugger discovery and evaluation", () => {
  it("renews deadlines on reuse and never leases the same socket concurrently", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter({ timeoutMs: 500 });
    state.evaluate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return 42;
    };
    for (let index = 0; index < 3; index++) {
      expect(await nui.evaluate("My-Hud_test", "return 42")).toBe(42);
    }
    expect(state.connections).toBe(1);
    expect(
      await Promise.all([
        nui.evaluate("My-Hud_test", "return 42"),
        nui.evaluate("My-Hud_test", "return 42"),
      ]),
    ).toEqual([42, 42]);
    expect(state.connections).toBe(2);
  });
  it("expires idle connections and closes retained sockets on shutdown", async () => {
    const { adapter, state, wss } = await fakeDebugger();
    const nui = adapter();
    await nui.frames();
    const idle = [...wss.clients][0]!;
    await new Promise<void>((resolve) => idle.once("close", () => resolve()));
    expect(wss.clients.size).toBe(0);
    await nui.frames();
    expect(state.connections).toBe(2);
    const retained = [...wss.clients][0]!;
    const closed = new Promise<void>((resolve) =>
      retained.once("close", () => resolve()),
    );
    nui.close();
    await closed;
    expect(wss.clients.size).toBe(0);
  });
  it("uses a new main-world context after navigation on a retained socket", async () => {
    const { adapter, state, wss } = await fakeDebugger();
    const nui = adapter();
    await nui.evaluate("My-Hud_test", "return 42");
    state.contexts = false;
    const socket = [...wss.clients][0]!;
    socket.send(
      JSON.stringify({
        method: "Runtime.executionContextsCleared",
        params: {},
      }),
    );
    socket.send(
      JSON.stringify({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 101,
            auxData: { frameId: "resource-frame", isDefault: true },
          },
        },
      }),
    );
    expect(await nui.evaluate("My-Hud_test", "return 42")).toEqual({
      contextId: 101,
    });
    expect(state.connections).toBe(1);
  });
  it("reuses idle CDP sockets but refreshes frame ownership before each action", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    state.evaluate = () => 42;
    expect(await nui.evaluate("My-Hud_test", "return 42")).toBe(42);
    expect(await nui.evaluate("My-Hud_test", "return 42")).toBe(42);
    expect(state.connections).toBe(1);
    expect(state.requests).toHaveLength(2);
    state.trees.get("root")!.childFrames = [];
    await expect(nui.evaluate("My-Hud_test", "return 42")).rejects.toThrow(
      "not found",
    );
    expect(
      state.commands.filter((command) => command.method === "Runtime.evaluate"),
    ).toHaveLength(2);
  });
  it("does not retry a failed CDP action and can reconnect on the next call", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    state.intercept = (command, socket) => {
      if (command.method !== "Runtime.evaluate") return false;
      socket.terminate();
      return true;
    };
    await expect(nui.evaluate("My-Hud_test", "return 42")).rejects.toThrow(
      "disconnected",
    );
    expect(
      state.commands.filter((command) => command.method === "Runtime.evaluate"),
    ).toHaveLength(1);
    state.intercept = undefined;
    state.evaluate = () => 42;
    expect(await nui.evaluate("My-Hud_test", "return 42")).toBe(42);
    expect(state.connections).toBe(2);
  });
  it("attributes srcdoc and blank children to their owning resource, not external pages", async () => {
    const { adapter, addTarget, state } = await fakeDebugger();
    state.targets = [];
    addTarget("nested", {
      frame: { id: "owner", url: "nui://fixture/index.html" },
      childFrames: [
        {
          frame: { id: "srcdoc", url: "about:srcdoc" },
          childFrames: [{ frame: { id: "blank", url: "about:blank" } }],
        },
        {
          frame: { id: "external", url: "https://example.com/" },
          childFrames: [
            { frame: { id: "external-child", url: "about:blank" } },
          ],
        },
      ],
    });
    const nui = adapter();
    const frames = await nui.frames();
    expect(frames.find((frame) => frame.frameId === "srcdoc")?.resource).toBe(
      "fixture",
    );
    expect(frames.find((frame) => frame.frameId === "blank")?.resource).toBe(
      "fixture",
    );
    expect(
      frames.find((frame) => frame.frameId === "external-child")?.resource,
    ).toBeNull();
    await expect(nui.evaluate("fixture", "return 1")).rejects.toThrow(
      "Ambiguous",
    );
    state.evaluate = () => 1;
    await expect(nui.evaluate("fixture", "return 1", "srcdoc")).resolves.toBe(
      1,
    );
  });
  it("finds nested resource frames without exposing websocket endpoints or mapping external pages", async () => {
    const { adapter, state } = await fakeDebugger();
    const frames = await adapter().frames();
    expect(frames).toEqual([
      {
        resource: null,
        frameId: "root-frame",
        url: "nui://game/ui/root.html",
        targetId: "root",
      },
      {
        resource: "My-Hud_test",
        frameId: "resource-frame",
        url: "https://cfx-nui-My-Hud_test/ui/index.html",
        targetId: "root",
      },
      {
        resource: null,
        frameId: "external-frame",
        url: "https://example.com/My-Hud_test",
        targetId: "root",
      },
    ]);
    expect(state.requests).toEqual(["/json/list"]);
  });

  it("uses default main-world contexts, supports return/await and rediscovers after restarts", async () => {
    const { adapter, state, addTarget } = await fakeDebugger();
    const nui = adapter();
    state.delayedContexts = true;
    state.evaluate = (params) => runInNewContext(String(params.expression));
    await expect(
      nui.evaluate("My-Hud_test", "return await Promise.resolve(42);"),
    ).resolves.toBe(42);
    const command = state.commands.find(
      (entry) => entry.method === "Runtime.evaluate",
    )!;
    expect(command.params).toMatchObject({
      contextId: 13,
      awaitPromise: true,
      returnByValue: true,
    });
    state.targets = [];
    addTarget("new", {
      frame: { id: "restarted", url: "nui://My-Hud_test/index.html" },
    });
    await expect(
      nui.evaluate("My-Hud_test", "return 'restarted';", "restarted"),
    ).resolves.toBe("restarted");
    expect(state.requests).toHaveLength(2);
    await expect(nui.evaluate("my-hud_test", "return 1")).rejects.toThrow(
      "not found",
    );
    await expect(
      nui.evaluate("My-Hud_test", "return 1", "external-frame"),
    ).rejects.toThrow("not found");
  });

  it("rejects ambiguous frames and permits an explicit unique frame id", async () => {
    const { adapter, addTarget } = await fakeDebugger();
    addTarget("second", {
      frame: { id: "other", url: "nui://My-Hud_test/index.html" },
    });
    const nui = adapter();
    await expect(nui.evaluate("My-Hud_test", "return 1")).rejects.toThrow(
      "Ambiguous",
    );
    await expect(
      nui.evaluate("My-Hud_test", "return 1", "other"),
    ).resolves.toEqual({ contextId: 11 });
    addTarget("third", {
      frame: { id: "other", url: "nui://My-Hud_test/index.html" },
    });
    await expect(
      nui.evaluate("My-Hud_test", "return 1", "other"),
    ).rejects.toThrow("Ambiguous");
  });

  it.each([
    "https://example.com",
    "https://cfx-nui-My-Hud_test.example.com/",
    "https://cfx-nui-My-Hud_test.example.com:8080/",
    "https://cfx-nui-My-Hud_test@example.com/",
    "about:blank",
    "file:///My-Hud_test/index.html",
    "nui://game/ui/root.html",
  ])("does not map unrelated URL %s to the selected resource", async (url) => {
    const { adapter, state } = await fakeDebugger();
    state.trees.set("root", { frame: { id: "frame", url } });
    const nui = adapter();
    await expect(nui.frames()).resolves.toEqual([
      { resource: null, frameId: "frame", url, targetId: "root" },
    ]);
    await expect(nui.evaluate("My-Hud_test", "return 1")).rejects.toThrow(
      "not found",
    );
  });

  it("surfaces evaluation exceptions and CDP protocol errors", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    state.evaluate = () => {
      throw new Error("intentional JS exception");
    };
    await expect(
      nui.evaluate("My-Hud_test", "throw new Error()"),
    ).rejects.toThrow("intentional JS exception");
    state.intercept = (command, ws) => {
      ws.send(
        JSON.stringify({
          id: command.id,
          error: { message: "Target detached" },
        }),
      );
      return true;
    };
    await expect(nui.frames()).rejects.toThrow("Target detached");
  });
});

describe("NuiDebugger game screenshots", () => {
  const options = {
    includeNui: false,
    maxWidth: 1280,
    format: "jpeg" as const,
    quality: 0.85,
  };
  const image = {
    data: "/9j/AAAA",
    mimeType: "image/jpeg",
    width: 1280,
    height: 720,
    capturedAt: "2026-09-05T00:00:00.000Z",
  };

  it.each([false, true])(
    "captures in the bridge's own context with includeNui=%s",
    async (includeNui) => {
      const { adapter, state } = await fakeDebugger();
      let received: GameCaptureOptions | undefined;
      state.evaluate = (params) =>
        runInNewContext(String(params.expression), {
          innerWidth: 1920,
          innerHeight: 1080,
          doluMcpCapture: {
            version: 1,
            capture: (args: GameCaptureOptions) => {
              received = args;
              return image;
            },
          },
        });
      const result = await adapter().gameScreenshot("My-Hud_test", {
        ...options,
        includeNui,
      });
      expect(result).toMatchObject({
        ...image,
        includeNui,
        cefTargetId: "root",
      });
      expect(received).toMatchObject({
        maxWidth: 1280,
        format: "jpeg",
        quality: 0.85,
      });
      expect(received!.maxBytes).toBeGreaterThan(0);
      expect(received!.timeoutMs).toBeLessThanOrEqual(2000);
      const evaluations = state.commands.filter(
        (command) => command.method === "Runtime.evaluate",
      );
      expect(evaluations).toHaveLength(2);
      expect(evaluations.every((entry) => entry.params.contextId === 13)).toBe(
        true,
      );
      const captures = state.commands.filter(
        (command) => command.method === "Page.captureScreenshot",
      );
      expect(captures).toHaveLength(includeNui ? 1 : 0);
      if (includeNui) {
        expect(received!.overlay).toBe("iVBORw0KGgoAAAANSUhEUg==");
        expect(result.cefCapturedAt).toEqual(expect.any(String));
        expect(captures[0]!.params).toMatchObject({
          fromSurface: true,
          clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 2 / 3 },
        });
      } else {
        expect(received!.overlay).toBeUndefined();
        expect(result.cefCapturedAt).toBeUndefined();
      }
    },
  );

  it("reports an unloaded capture bridge explicitly", async () => {
    const { adapter, state } = await fakeDebugger();
    state.evaluate = (params) => runInNewContext(String(params.expression));
    await expect(
      adapter().gameScreenshot("My-Hud_test", options),
    ).rejects.toThrow("build and restart");
  });

  it("preserves a requested PNG format", async () => {
    const { adapter, state } = await fakeDebugger();
    const png = {
      ...image,
      data: "iVBORw0KGgoAAAANSUhEUg==",
      mimeType: "image/png",
    };
    state.evaluate = (params) =>
      String(params.expression).includes("innerWidth")
        ? { width: 1920, height: 1080 }
        : png;
    await expect(
      adapter().gameScreenshot("My-Hud_test", { ...options, format: "png" }),
    ).resolves.toMatchObject(png);
  });

  it("does not fall back to the game when the CEF overlay fails", async () => {
    const { adapter, state } = await fakeDebugger();
    state.evaluate = () => ({ width: 1920, height: 1080 });
    state.intercept = (command, socket) => {
      if (command.method !== "Page.captureScreenshot") return false;
      socket.send(
        JSON.stringify({
          id: command.id,
          error: { message: "Capture failed" },
        }),
      );
      return true;
    };
    await expect(
      adapter().gameScreenshot("My-Hud_test", { ...options, includeNui: true }),
    ).rejects.toThrow("Capture failed");
    expect(
      state.commands.filter((command) => command.method === "Runtime.evaluate"),
    ).toHaveLength(1);
  });

  it("rejects composition outside the main FiveM root target", async () => {
    const { adapter, state } = await fakeDebugger();
    state.trees.get("root")!.frame.url = "https://example.com/";
    state.evaluate = () => ({ width: 1920, height: 1080 });
    await expect(
      adapter().gameScreenshot("My-Hud_test", { ...options, includeNui: true }),
    ).rejects.toThrow("main FiveM CEF root");
  });

  it.each([
    { reason: "MIME", value: { mimeType: "image/png" } },
    { reason: "base64", value: { data: "not a PNG or JPEG" } },
    { reason: "width", value: { width: 1920 } },
    { reason: "height", value: { height: 3000 } },
    { reason: "size", value: { data: "/9j/" + "AAAA".repeat(13_000) } },
  ])("rejects malformed or oversized images: $reason", async ({ value }) => {
    const { adapter, state } = await fakeDebugger();
    state.evaluate = (params) =>
      runInNewContext(String(params.expression), {
        innerWidth: 1920,
        innerHeight: 1080,
        doluMcpCapture: {
          version: 1,
          capture: () => ({ ...image, ...value }),
        },
      });
    await expect(
      adapter().gameScreenshot("My-Hud_test", options),
    ).rejects.toThrow();
  });

  it("serializes captures and releases the lock after completion", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    let release!: () => void;
    let started!: () => void;
    const capturing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.evaluate = (params) =>
      runInNewContext(String(params.expression), {
        innerWidth: 1920,
        innerHeight: 1080,
        doluMcpCapture: {
          version: 1,
          capture: async () => {
            started();
            await wait;
            return image;
          },
        },
      });
    const first = nui.gameScreenshot("My-Hud_test", options);
    await capturing;
    await expect(nui.gameScreenshot("My-Hud_test", options)).rejects.toThrow(
      "already active",
    );
    release();
    await expect(first).resolves.toMatchObject(image);
    await expect(
      nui.gameScreenshot("My-Hud_test", options),
    ).resolves.toMatchObject(image);
  });

  it("bounds stalled captures and permits a later retry after failure", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter({ timeoutMs: 100 });
    state.evaluate = (params) =>
      runInNewContext(String(params.expression), {
        innerWidth: 1920,
        innerHeight: 1080,
        doluMcpCapture: {
          version: 1,
          capture: () => new Promise(() => {}),
        },
      });
    await expect(nui.gameScreenshot("My-Hud_test", options)).rejects.toThrow(
      "timed out",
    );
    state.evaluate = (params) =>
      String(params.expression).includes("innerWidth")
        ? { width: 1920, height: 1080 }
        : image;
    await expect(
      nui.gameScreenshot("My-Hud_test", options),
    ).resolves.toMatchObject(image);
  });
});

describe("NuiDebugger DOM operations", () => {
  it("reads bridge readiness without capturing or invoking bridge accessors", async () => {
    const { adapter, state } = await fakeDebugger();
    let captured = false;
    state.evaluate = (params) =>
      runInNewContext(String(params.expression), {
        doluMcpBuild: "test-build",
        doluMcpCapture: {
          version: 1,
          capture: () => {
            captured = true;
          },
        },
        document: { readyState: "complete" },
      });
    const nui = adapter();
    await expect(nui.bridgeStatus("My-Hud_test")).resolves.toEqual({
      buildId: "test-build",
      captureVersion: 1,
      captureAvailable: true,
      documentReadyState: "complete",
    });
    expect(captured).toBe(false);
    state.evaluate = (params) =>
      runInNewContext(
        "Object.defineProperty(globalThis, 'doluMcpCapture', {get(){throw new Error('Getter accessed')}});" +
          String(params.expression),
        { document: { readyState: "loading" } },
      );
    await expect(nui.bridgeStatus("My-Hud_test")).resolves.toMatchObject({
      buildId: null,
      captureVersion: null,
      captureAvailable: false,
    });
  });

  it("accepts issued document refs and rejects them after mutation or debugger restart", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    state.evaluate = dom.evaluate;
    const nui = adapter();
    const snapshot = (await nui.snapshot("My-Hud_test")) as {
      elements: Array<{ ref: string }>;
    };
    const ref = snapshot.elements[0]!.ref;
    await expect(
      nui.interact("My-Hud_test", { action: "click", ref }),
    ).resolves.toMatchObject({ clicked: true, trusted: false });
    await expect(
      adapter().interact("My-Hud_test", { action: "click", ref }),
    ).rejects.toThrow("Stale");
    dom.records.push({ type: "attributes", target: dom.button });
    await expect(
      nui.interact("My-Hud_test", { action: "click", ref }),
    ).rejects.toThrow("Stale");
    expect(dom.button.clicks).toBe(1);
  });

  it.each(["hidden", "disabled", "obscured"])(
    "does not dispatch input to a %s element",
    async (reason) => {
      const { adapter, state } = await fakeDebugger();
      const dom = domFixture();
      if (reason === "hidden") dom.button.style.display = "none";
      if (reason === "disabled") dom.button.disabled = true;
      if (reason === "obscured") dom.hit(dom.input);
      state.evaluate = dom.evaluate;
      await expect(
        adapter().interact("My-Hud_test", {
          action: "click",
          selector: "#button",
          mode: "cdp",
        }),
      ).rejects.toThrow();
      expect(
        state.commands.filter((c) => c.method.startsWith("Input.")),
      ).toHaveLength(0);
      expect(dom.button.clicks).toBe(0);
    },
  );

  it("translates iframe coordinates and dispatches a single CDP click without DOM click", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    state.evaluate = dom.evaluate;
    await adapter().interact("My-Hud_test", {
      action: "click",
      selector: "#button",
      mode: "cdp",
    });
    expect(
      state.commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params),
    ).toEqual([
      { type: "mousePressed", x: 160, y: 90, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 160, y: 90, button: "left", clickCount: 1 },
    ]);
    expect(
      state.commands.find((c) => c.method === "DOM.getFrameOwner")?.params,
    ).toEqual({ frameId: "resource-frame" });
    expect(dom.button.clicks).toBe(0);
  });

  it("rejects clipped parent frames before DOM or CDP effects", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    state.evaluate = dom.evaluate;
    state.intercept = (command, ws) => {
      if (command.method !== "Runtime.callFunctionOn") return false;
      ws.send(
        JSON.stringify({
          id: command.id,
          result: { exceptionDetails: { text: "clipped" } },
        }),
      );
      return true;
    };
    const nui = adapter();
    await expect(nui.click("My-Hud_test", "#button")).rejects.toThrow(
      "clipped",
    );
    await expect(
      nui.interact("My-Hud_test", {
        action: "fill",
        selector: "#input",
        text: "private",
      }),
    ).rejects.toThrow("clipped");
    expect(dom.button.clicks).toBe(0);
    expect(dom.input.selections).toBe(0);
    expect(state.commands.some((c) => c.method.startsWith("Input."))).toBe(
      false,
    );
  });

  it("fills through CDP after focusing and selecting the correct input", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    dom.hit(dom.input);
    state.evaluate = dom.evaluate;
    await expect(
      adapter().interact("My-Hud_test", {
        action: "fill",
        selector: "#input",
        text: "private-value",
      }),
    ).resolves.toMatchObject({ dispatched: true });
    expect(dom.document.activeElement).toBe(dom.input);
    expect(dom.input.selections).toBe(1);
    expect(
      state.commands.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(1);
    expect(
      state.commands.find((c) => c.method === "Input.insertText")?.params,
    ).toEqual({ text: "private-value" });
  });

  it("focuses allowlisted keys and sends hover/scroll without OS input", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    state.evaluate = dom.evaluate;
    const nui = adapter();
    await nui.interact("My-Hud_test", {
      action: "key",
      selector: "#button",
      key: "a",
      modifiers: ["Control"],
    });
    await nui.interact("My-Hud_test", { action: "hover", selector: "#button" });
    await nui.interact("My-Hud_test", {
      action: "scroll",
      selector: "#button",
      deltaY: 123,
    });
    expect(dom.document.activeElement).toBe(dom.button);
    expect(
      state.commands
        .filter((c) => c.method === "Input.dispatchKeyEvent")
        .map((c) => c.params),
    ).toEqual([
      {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      },
      {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      },
    ]);
    expect(
      state.commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params.type),
    ).toEqual(["mouseMoved", "mouseWheel"]);
  });

  it("waits with Node polling and supports timeout and abort even if page timers stall", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    let polls = 0;
    state.evaluate = () => ({ matched: ++polls >= 2 });
    await expect(
      nui.waitFor("My-Hud_test", {
        selector: "#ready",
        condition: "visible",
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ matched: true });
    state.evaluate = () => ({ matched: false });
    await expect(
      nui.waitFor("My-Hud_test", {
        selector: "#ready",
        condition: "visible",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out");
    const controller = new AbortController();
    const pending = nui.waitFor(
      "My-Hud_test",
      { selector: "#ready", condition: "visible", timeoutMs: 1000 },
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow(/aborted|closed/);
  });

  it("aborts a stalled HTTP discovery without closing other debugger operations", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    state.http = () => {};
    const controller = new AbortController();
    const waiting = nui.waitFor(
      "My-Hud_test",
      { selector: "#button", condition: "visible" },
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    await expect(waiting).rejects.toThrow("aborted");
    state.http = undefined;
    await expect(nui.frames()).resolves.toHaveLength(3);
  });

  it("clicks safely quoted selectors and reports missing, invalid and ambiguous selectors", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    const dom = domFixture();
    let selectorReceived = "";
    let matches = [dom.button];
    dom.document.querySelectorAll = (selector) => {
      selectorReceived = selector;
      if (selector === "[") throw new Error("syntax");
      return matches;
    };
    state.evaluate = dom.evaluate;
    const selector = '[data-test="quoted"]';
    await expect(nui.click("My-Hud_test", selector)).resolves.toEqual({
      clicked: true,
      selector,
    });
    expect(dom.button.clicks).toBe(1);
    expect(selectorReceived).toBe(selector);
    matches = [];
    await expect(nui.click("My-Hud_test", "#missing")).rejects.toThrow(
      "not found",
    );
    matches = [dom.button, dom.input];
    await expect(nui.click("My-Hud_test", ".multiple")).rejects.toThrow(
      "Ambiguous",
    );
    await expect(nui.click("My-Hud_test", "[")).rejects.toThrow(
      "Invalid CSS selector",
    );
  });

  it("snapshot runs without modern replaceAll and never reads input values or private text", async () => {
    const { adapter, state } = await fakeDebugger();
    const dom = domFixture();
    for (const el of [dom.input, dom.textarea])
      Object.defineProperty(el, "value", {
        get: () => {
          throw new Error("Read private value");
        },
      });
    dom.run("String.prototype.replaceAll = undefined;");
    state.evaluate = dom.evaluate;
    const result = await adapter().snapshot("My-Hud_test");
    expect(JSON.stringify(result)).not.toContain("secret password");
    expect(result).toMatchObject({
      title: "Example",
      text: "hello world",
      elements: [
        { tag: "button", text: "hello world" },
        { tag: "input", text: "" },
        { tag: "textarea", text: "" },
      ],
    });
  });

  it("returns a whole-target NUI PNG, without pretending to crop the resource frame", async () => {
    const { adapter, state } = await fakeDebugger();
    await expect(adapter().screenshot("My-Hud_test")).resolves.toBe(
      "iVBORw0KGgoAAAANSUhEUg==",
    );
    expect(
      state.commands.find((entry) => entry.method === "Page.captureScreenshot")
        ?.params,
    ).toEqual({ format: "png", fromSurface: true });
  });
});

describe("NuiDebugger observation transport", () => {
  it("collects buffered-at-enable events by known context and keeps a long-lived socket until stop", async () => {
    const { adapter, state } = await fakeDebugger();
    let stream: WebSocket | undefined;
    state.intercept = (command, ws) => {
      if (command.method === "Runtime.enable") {
        stream = ws;
        ws.send(
          JSON.stringify({
            method: "Runtime.executionContextCreated",
            params: {
              context: {
                id: 13,
                auxData: { frameId: "resource-frame", isDefault: true },
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: {
              timestamp: Date.now(),
              executionContextId: 13,
              type: "log",
              args: [{ type: "string", value: "from-start" }],
            },
          }),
        );
        ws.send(JSON.stringify({ id: command.id, result: {} }));
        return true;
      }
      return false;
    };
    const nui = adapter();
    const started = await nui.startObservation("My-Hud_test", { playerId: 1 });
    expect(stream?.readyState).toBe(WebSocket.OPEN);
    expect(
      (await nui.readObservation(started.id)).entries[0]?.data,
    ).toMatchObject({ args: [{ value: "from-start" }] });
    expect((await nui.stopObservation(started.id)).status).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stream?.readyState).toBe(WebSocket.CLOSED);
  });

  it("reports observation disconnects, cancels on close, and does not retain listeners", async () => {
    const { adapter, state } = await fakeDebugger();
    let stream: WebSocket | undefined;
    state.intercept = (command, ws) => {
      if (command.method === "Page.enable") stream = ws;
      return false;
    };
    const nui = adapter();
    const started = await nui.startObservation("My-Hud_test", {
      network: true,
    });
    stream!.terminate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await nui.readObservation(started.id)).toMatchObject({
      status: "disconnected",
      error: expect.stringContaining("disconnected"),
    });
    await nui.startObservation("My-Hud_test", {});
    nui.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stream!.readyState).toBe(WebSocket.CLOSED);
    await expect(nui.startObservation("My-Hud_test", {})).rejects.toThrow(
      "closed",
    );
  });
});

describe("NuiDebugger boundaries and lifecycle", () => {
  it.each([
    "ws://example.com:PORT/devtools/page/root",
    "ws://127.0.0.1:1/devtools/page/root",
    "wss://127.0.0.1:PORT/devtools/page/root",
    "ws://user:password@127.0.0.1:PORT/devtools/page/root",
    "ws://127.0.0.1:PORT@evil.example/devtools/page/root",
    "ws://127.0.0.1:PORT/devtools/page/root#fragment",
    "http://127.0.0.1:PORT/devtools/page/root",
  ])(
    "refuses network-pivot websocket URL %s before connecting",
    async (url) => {
      const { adapter, state, port } = await fakeDebugger();
      state.targets[0]!.webSocketDebuggerUrl = url.replace(
        "PORT",
        String(port),
      );
      await expect(adapter().frames()).rejects.toThrow("Unsafe");
      expect(state.commands).toHaveLength(0);
    },
  );

  it("normalizes localhost to the configured fixed loopback address", async () => {
    const { adapter, state } = await fakeDebugger();
    state.targets[0]!.webSocketDebuggerUrl =
      state.targets[0]!.webSocketDebuggerUrl.replace("127.0.0.1", "localhost");
    await expect(adapter().frames()).resolves.toHaveLength(3);
  });

  it("does not follow HTTP redirects", async () => {
    const { adapter, state } = await fakeDebugger();
    state.http = (response) => {
      response.writeHead(302, { Location: "http://example.com/" });
      response.end();
    };
    await expect(adapter().frames()).rejects.toThrow(
      "redirects are not allowed",
    );
  });

  it("bounds HTTP and websocket responses", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter({ maxResultBytes: 2048 });
    state.http = (response) => response.end(" ".repeat(2049));
    await expect(nui.frames()).rejects.toThrow("exceeds maxResultBytes");
    state.http = undefined;
    state.intercept = (_command, ws) => {
      ws.send(" ".repeat(2049));
      return true;
    };
    await expect(nui.frames()).rejects.toThrow(/payload|message size/i);
  });

  it("bounds outgoing evaluation code", async () => {
    const { adapter } = await fakeDebugger();
    await expect(
      adapter({ maxResultBytes: 2048 }).evaluate(
        "My-Hud_test",
        " ".repeat(2049),
      ),
    ).rejects.toThrow("request exceeds");
  });

  it("rejects malformed HTTP and websocket JSON", async () => {
    const { adapter, state } = await fakeDebugger();
    state.http = (response) => response.end("{");
    await expect(adapter().frames()).rejects.toThrow();
    state.http = undefined;
    state.intercept = (_command, ws) => {
      ws.send("{");
      return true;
    };
    await expect(adapter().frames()).rejects.toThrow("Invalid NUI CDP JSON");
  });

  it("rejects disconnects with pending calls", async () => {
    const { adapter, state } = await fakeDebugger();
    state.intercept = (_command, ws) => {
      ws.terminate();
      return true;
    };
    await expect(adapter().frames()).rejects.toThrow("disconnected");
  });

  it("times out stalled CDP commands and missing main-world contexts", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter({ timeoutMs: 150 });
    state.intercept = () => true;
    await expect(nui.frames()).rejects.toThrow("timed out");
    state.intercept = undefined;
    state.contexts = false;
    await expect(nui.evaluate("My-Hud_test", "return 1")).rejects.toThrow(
      "main-world context",
    );
  });

  it("times out HTTP responses even when the peer stays connected", async () => {
    const { adapter, state } = await fakeDebugger();
    state.http = () => undefined;
    await expect(adapter({ timeoutMs: 100 }).frames()).rejects.toThrow(
      "timed out",
    );
  });

  it("close interrupts active CDP and HTTP work and prevents reuse", async () => {
    const { adapter, state } = await fakeDebugger();
    const nui = adapter();
    let received!: () => void;
    const commandReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    state.intercept = () => {
      received();
      return true;
    };
    const pending = expect(nui.frames()).rejects.toThrow("closed");
    await commandReceived;
    nui.close();
    await pending;
    await expect(nui.frames()).rejects.toThrow("closed");

    const second = adapter();
    const requestReceived = new Promise<void>((resolve) => {
      state.http = () => resolve();
    });
    const httpPending = expect(second.frames()).rejects.toThrow("closed");
    await requestReceived;
    second.close();
    await httpPending;
  });

  it("validates constructor limits", () => {
    for (const options of [
      { port: 0, timeoutMs: 100, maxResultBytes: 1024 },
      { port: 65536, timeoutMs: 100, maxResultBytes: 1024 },
      { port: 13172, timeoutMs: 0, maxResultBytes: 1024 },
      { port: 13172, timeoutMs: 100, maxResultBytes: -1 },
    ]) {
      expect(() => new NuiDebugger(options)).toThrow();
    }
  });
});
