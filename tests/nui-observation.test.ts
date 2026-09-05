import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  NuiObservations,
  nuiObservationSchema,
  type ObservationConnection,
} from "../src/server/nui-observation";

class Connection implements ObservationConnection {
  events = new Set<(method: string, params: Record<string, unknown>) => void>();
  failures = new Set<(error: Error) => void>();
  commands: string[] = [];
  closed = false;
  enable = () => {};
  async call(method: string) {
    this.commands.push(method);
    return {};
  }
  async context() {
    this.commands.push("Runtime.enable");
    this.enable();
    return 11;
  }
  onEvent(fn: (method: string, params: Record<string, unknown>) => void) {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }
  onFailure(fn: (error: Error) => void) {
    this.failures.add(fn);
    return () => this.failures.delete(fn);
  }
  frameForContext(id: unknown) {
    return id === 11 ? "frame" : id === 12 ? "other" : undefined;
  }
  close() {
    this.closed = true;
  }
  emit(method: string, params: Record<string, unknown>) {
    for (const fn of this.events) fn(method, params);
  }
  log(message: string, id = 11, timestamp = Date.now()) {
    this.emit("Runtime.consoleAPICalled", {
      executionContextId: id,
      timestamp,
      type: "log",
      args: [{ type: "string", value: message }],
    });
  }
}
const frame = { resource: "hud", frameId: "frame", targetId: "target" };
const observations: NuiObservations[] = [];
function fixture(maxBytes = 8192) {
  const manager = new NuiObservations(maxBytes);
  observations.push(manager);
  return { manager, connection: new Connection() };
}
afterEach(() => {
  for (const manager of observations.splice(0)) manager.close();
  vi.useRealTimers();
});

describe("bounded NUI observations", () => {
  it("uses Node timer handles instead of FiveM's numeric global timers", async () => {
    vi.stubGlobal(
      "setTimeout",
      vi.fn(() => 1),
    );
    vi.stubGlobal(
      "setInterval",
      vi.fn(() => 2),
    );
    const { manager, connection } = fixture();
    try {
      const session = await manager.start(connection, frame, {});
      expect(session.status).toBe("active");
      await manager.stop(session.id);
      expect(connection.closed).toBe(true);
    } finally {
      manager.close();
      vi.unstubAllGlobals();
    }
  });
  it("attaches before Runtime.enable, keeps from-start events, skips old and unknown frame events", async () => {
    const { manager, connection } = fixture();
    connection.enable = () => {
      connection.log("old", 11, Date.now() - 100000);
      connection.log("selected");
      connection.log("other", 12);
      connection.log("unknown", 999);
    };
    const session = await manager.start(connection, frame, {});
    const result = await manager.read(session.id);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.data).toMatchObject({
      args: [{ value: "selected" }],
    });
    expect(result.skipped).toBe(3);
    expect(connection.commands).not.toContain("Network.enable");
  });

  it("never fetches object properties or previews, sanitizes URL metadata and nested stack traces", async () => {
    const { manager, connection } = fixture();
    const session = await manager.start(connection, frame, { network: true });
    const privateUrl =
      "https://user:password@example.com/path?token=secret#fragment";
    connection.emit("Runtime.consoleAPICalled", {
      timestamp: Date.now(),
      executionContextId: 11,
      type: "log",
      args: [
        {
          type: "object",
          subtype: "node",
          objectId: "private-id",
          description: "<input value=secret>",
          preview: { properties: [{ name: "value", value: "secret" }] },
        },
        { type: "string", value: privateUrl },
      ],
      stackTrace: {
        callFrames: [{ url: privateUrl }],
        parent: { callFrames: [{ url: privateUrl }] },
      },
    });
    connection.emit("Runtime.exceptionThrown", {
      timestamp: Date.now(),
      exceptionDetails: {
        executionContextId: 11,
        text: "Uncaught",
        url: privateUrl,
        exception: {
          type: "object",
          subtype: "error",
          description: `Error at ${privateUrl}`,
        },
        stackTrace: { callFrames: [{ url: privateUrl }] },
      },
    });
    connection.emit("Network.requestWillBeSent", {
      frameId: "frame",
      requestId: "request",
      request: {
        url: privateUrl,
        method: "POST",
        headers: { Authorization: "secret" },
        postData: "secret",
      },
    });
    connection.emit("Network.responseReceived", {
      frameId: "frame",
      requestId: "request",
      response: {
        url: privateUrl,
        status: 200,
        mimeType: "application/json",
        headers: { "set-cookie": "secret" },
      },
    });
    connection.emit("Network.loadingFailed", {
      requestId: "request",
      errorText: "failed",
    });
    const result = await manager.read(session.id);
    expect(result.entries).toHaveLength(5);
    const serialized = JSON.stringify(result.entries);
    for (const forbidden of [
      "secret",
      "password",
      "fragment",
      "private-id",
      "headers",
      "preview",
      "postData",
      "user:",
    ])
      expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain("https://example.com/path");
    expect(connection.commands).toEqual([
      "Runtime.enable",
      "Page.enable",
      "Network.enable",
    ]);
  });

  it("does not attribute unknown or other-frame network responses to the selected frame", async () => {
    const { manager, connection } = fixture();
    const session = await manager.start(connection, frame, { network: true });
    connection.emit("Network.requestWillBeSent", {
      requestId: "other",
      frameId: "other",
      request: { url: "https://example.com" },
    });
    connection.emit("Network.responseReceived", {
      requestId: "other",
      response: { url: "https://example.com", status: 200 },
    });
    connection.emit("Network.responseReceived", {
      requestId: "unknown",
      response: { url: "https://example.com", status: 200 },
    });
    expect((await manager.read(session.id)).entries).toEqual([]);
  });

  it("enforces ring size, monotonic cursors, byte bounds and truncation", async () => {
    const { manager, connection } = fixture(800);
    const session = await manager.start(connection, frame, { maxEntries: 2 });
    for (let i = 0; i < 10; i++) connection.log(`entry-${i}`);
    const result = await manager.read(session.id, { cursor: 0, limit: 1 });
    expect(result.count).toBeLessThanOrEqual(2);
    expect(result.bytes).toBeLessThanOrEqual(800);
    expect(result.truncated).toBe(true);
    expect(result.cursorDropped).toBeGreaterThan(0);
    expect(result.entries).toHaveLength(1);
    const next = await manager.read(session.id, { cursor: result.cursor });
    expect(next.entries.every((e) => e.cursor >= result.cursor)).toBe(true);
    connection.log("x".repeat(2000));
    expect((await manager.read(session.id)).dropped).toBeGreaterThan(
      result.dropped,
    );
  });

  it("reevaluates authorization on read and clears inaccessible entries", async () => {
    const { manager, connection } = fixture();
    let allowed = true;
    const guard = vi.fn(async () => {
      if (!allowed) throw new Error("denied");
    });
    const session = await manager.start(
      connection,
      frame,
      { playerId: 7 },
      guard,
    );
    connection.log("private");
    expect((await manager.read(session.id)).playerId).toBe(7);
    allowed = false;
    await expect(manager.read(session.id)).rejects.toThrow(
      "authorization revoked",
    );
    expect(connection.closed).toBe(true);
    allowed = true;
    await expect(manager.read(session.id)).rejects.toThrow(
      "authorization revoked",
    );
    expect(await manager.list()).toEqual([]);
  });

  it("automatically revokes idle sessions and expires without a client read", async () => {
    const { manager, connection } = fixture();
    let allowed = true;
    const session = await manager.start(
      connection,
      frame,
      { durationMs: 5000 },
      async () => {
        if (!allowed) throw new Error();
      },
    );
    allowed = false;
    await delay(1100);
    expect(connection.closed).toBe(true);
    await expect(manager.read(session.id)).rejects.toThrow("revoked");
    const other = new Connection();
    const timed = await manager.start(other, frame, { durationMs: 50 });
    await delay(75);
    expect(other.closed).toBe(true);
    expect((await manager.read(timed.id)).status).toBe("expired");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61000);
    await expect(manager.read(timed.id)).rejects.toThrow("Unknown");
  });

  it("reports disconnects and document navigation rather than silently claiming active success", async () => {
    const { manager, connection } = fixture();
    const session = await manager.start(connection, frame, {});
    for (const fail of connection.failures) fail(new Error("CDP disconnected"));
    expect(await manager.read(session.id)).toMatchObject({
      status: "disconnected",
      error: "CDP disconnected",
    });
    expect(connection.events.size).toBe(0);
    const other = new Connection();
    const navigated = await manager.start(other, frame, {});
    other.emit("Page.frameNavigated", { frame: { id: "frame" } });
    expect((await manager.read(navigated.id)).status).toBe("disconnected");
  });

  it("bounds active sessions and ended history, stop and close remove all listeners", async () => {
    const { manager } = fixture();
    const sessions = [];
    for (let i = 0; i < 8; i++)
      sessions.push(await manager.start(new Connection(), frame, {}));
    await expect(manager.start(new Connection(), frame, {})).rejects.toThrow(
      "limit",
    );
    for (const session of sessions) await manager.stop(session.id);
    for (let i = 0; i < 22; i++) {
      const connection = new Connection();
      const session = await manager.start(connection, frame, {});
      await manager.stop(session.id);
      expect(connection.closed).toBe(true);
      expect(connection.events.size).toBe(0);
    }
    expect(await manager.list()).toHaveLength(20);
    manager.close();
    expect(await manager.list()).toEqual([]);
  });

  it("rejects unbounded observation options", () => {
    expect(nuiObservationSchema.safeParse({ durationMs: 60001 }).success).toBe(
      false,
    );
    expect(nuiObservationSchema.safeParse({ maxEntries: 501 }).success).toBe(
      false,
    );
  });
});
