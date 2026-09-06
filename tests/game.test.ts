import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameService } from "../src/server/game";
import { events, VERSION, type ExecutionInput } from "../src/shared/protocol";
import { BUILD_ID } from "../src/shared/build";

describe("FiveM routing and ACE boundaries", () => {
  let game: GameService;
  let handlers: Map<string, (...args: unknown[]) => void>;
  let authorized: Set<number>;
  const network = vi.fn();
  const commands = vi.fn();
  const names = events("dolu_fivem_mcp");
  const input: ExecutionInput = {
    code: "return 42",
    language: "lua",
    timeoutMs: 1000,
    wait: false,
  };
  beforeEach(() => {
    handlers = new Map();
    authorized = new Set([7, 8]);
    network.mockClear();
    commands.mockClear();
    vi.stubGlobal("exports", {});
    vi.stubGlobal("require", () => {
      throw new Error("Not used");
    });
    vi.stubGlobal(
      "RegisterConsoleListener",
      (fn: (...args: unknown[]) => void) => handlers.set("console", fn),
    );
    vi.stubGlobal("onNet", (name: string, fn: (...args: unknown[]) => void) =>
      handlers.set(name, fn),
    );
    vi.stubGlobal("on", (name: string, fn: (...args: unknown[]) => void) =>
      handlers.set(name, fn),
    );
    vi.stubGlobal("emit", (name: string, ...args: unknown[]) =>
      handlers.get(name)?.(...args),
    );
    vi.stubGlobal("emitNet", network);
    vi.stubGlobal("IsPlayerAceAllowed", (id: string) =>
      authorized.has(Number(id)),
    );
    vi.stubGlobal("IsPrincipalAceAllowed", () => true);
    vi.stubGlobal("GetPlayerName", (id: string) => `Player ${id}`);
    vi.stubGlobal("GetPlayerEndpoint", () => "127.0.0.1");
    vi.stubGlobal("getPlayers", () => ["7", "8"]);
    vi.stubGlobal("GetNumResources", () => 2);
    vi.stubGlobal(
      "GetResourceByFindIndex",
      (index: number) => ["dolu_fivem_mcp", "example"][index],
    );
    vi.stubGlobal("GetResourceState", (name: string) =>
      ["dolu_fivem_mcp", "example"].includes(name) ? "started" : "missing",
    );
    vi.stubGlobal("ExecuteCommand", commands);
    game = new GameService("dolu_fivem_mcp", {
      port: 3210,
      ace: "dolu_fivem_mcp.use",
      cdpPort: 13172,
      cdpPlayer: 0,
      maxActive: 8,
    });
  });
  afterEach(async () => {
    game.close();
    // Drain game-thread cancellation callbacks before removing native doubles.
    await new Promise((resolve) => setImmediate(resolve));
    vi.unstubAllGlobals();
  });
  function from(playerId: number, name: string, ...args: unknown[]) {
    vi.stubGlobal("source", playerId);
    handlers.get(name)?.(...args);
  }
  function hello(id: number) {
    from(id, names.hello, {
      version: VERSION,
      buildId: BUILD_ID,
      nuiBuildId: BUILD_ID,
      nuiReady: true,
    });
  }

  it("rejects unauthorized and ambiguous targets; never broadcasts", async () => {
    authorized.delete(8);
    hello(8);
    await expect(game.execute("client", input, 8)).rejects.toThrow("Target");
    hello(7);
    const job = await game.execute("client", input);
    expect(job.playerId).toBe(7);
    expect(network).toHaveBeenCalledWith(names.execute, 7, expect.any(String));
    authorized.add(8);
    hello(8);
    await expect(game.execute("client", input)).rejects.toThrow(
      "Specify playerId",
    );
  });
  it("accepts only the selected player's result and rechecks permissions", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    const raw = JSON.stringify({
      ok: true,
      values: [42],
      logs: [],
      durationMs: 1,
    });
    from(8, names.result, job.id, raw);
    expect(game.jobs.get(job.id).state).toBe("running");
    from(7, names.result, job.id, raw);
    expect(game.jobs.get(job.id).state).toBe("completed");
    const next = await game.execute("client", input, 7);
    authorized.delete(7);
    from(7, names.result, next.id, raw);
    expect(game.jobs.get(next.id).state).toBe("cancelled");
  });
  it("treats malformed results as failures instead of hanging", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    from(7, names.result, job.id, "{}");
    expect(game.jobs.get(job.id).state).toBe("failed");
  });
  it("does not publish a late client's outcome as a completed execution", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(job.startedAt) + input.timeoutMs);
    try {
      from(
        7,
        names.result,
        job.id,
        JSON.stringify({
          ok: true,
          values: [42],
          logs: [{ level: "info", message: "late result" }],
          durationMs: input.timeoutMs,
        }),
      );
      expect(job.state).toBe("timed_out");
      expect(job.outcome).toBeUndefined();
      expect(game.logs.read({ source: "client" }).lines).toEqual([]);
      expect(
        game.logs.read({ contains: `execution ${job.id} completed` }).lines,
      ).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });
  it("executes server JavaScript and local Lua responses", async () => {
    const js = await game.execute("server", {
      ...input,
      language: "javascript",
      wait: true,
    });
    expect(js).toMatchObject({ state: "completed", outcome: { values: [42] } });
    const lua = await game.execute("server", input);
    handlers.get(names.luaResult)?.(
      lua.id,
      JSON.stringify({ ok: true, values: [12], logs: [], durationMs: 1 }),
    );
    expect(game.jobs.get(lua.id)).toMatchObject({
      state: "completed",
      outcome: { values: [12] },
    });
  });
  it("gates management on resource ACE and rejects invalid/self names", async () => {
    await expect(game.manage("restart", "example;quit")).rejects.toThrow();
    await expect(game.manage("stop", "dolu_fivem_mcp")).rejects.toThrow("Self");
    vi.stubGlobal("IsPrincipalAceAllowed", () => false);
    await expect(game.manage("restart", "example")).rejects.toThrow(
      "Missing ACE",
    );
    expect(commands).not.toHaveBeenCalled();
    vi.stubGlobal("IsPrincipalAceAllowed", () => true);
    await game.manage("restart", "example");
    expect(commands).toHaveBeenCalledWith("restart example");
  });
  it("requires local unambiguous CEF ownership", async () => {
    hello(7);
    expect(await game.assertLocalNui()).toBe(7);
    vi.stubGlobal("GetPlayerEndpoint", () => "10.0.0.12");
    await expect(game.assertLocalNui(7)).rejects.toThrow("loopback");
  });
  it("disconnects pending jobs when the player leaves", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    from(7, "playerDropped");
    expect(game.jobs.get(job.id).state).toBe("disconnected");
  });
  it("reports missing and mismatched readiness without boolean native assumptions", async () => {
    vi.stubGlobal("IsPlayerAceAllowed", () => 1);
    expect((await game.players())[0]).toMatchObject({
      authorized: true,
      ready: false,
      readinessReasons: ["missing_heartbeat"],
      clientBuildId: null,
      nuiReady: false,
    });
    from(7, names.hello, {
      version: VERSION,
      buildId: "stale",
      nuiBuildId: BUILD_ID,
      nuiReady: true,
    });
    expect((await game.players())[0]).toMatchObject({
      ready: false,
      readinessReasons: ["build_mismatch"],
      clientBuildId: "stale",
    });
    await expect(game.execute("client", input, 7)).rejects.toThrow("build");
    from(7, names.hello, {
      version: VERSION,
      buildId: BUILD_ID,
      nuiBuildId: "stale",
      nuiReady: true,
    });
    expect((await game.players())[0]).toMatchObject({
      ready: true,
      nuiReady: false,
      nuiReadinessReason: "nui_build_mismatch",
    });
    vi.stubGlobal("IsPlayerAceAllowed", () => 0);
    expect((await game.players())[0]).toMatchObject({
      authorized: false,
      ready: false,
    });
  });
  it("rejects legacy/malformed heartbeats and invalidates work on a new stale build", async () => {
    from(7, names.hello, "0.1.0", true);
    await expect(game.execute("client", input, 7)).rejects.toThrow("Target");
    hello(7);
    const job = await game.execute("client", input, 7);
    from(7, names.hello, {
      version: VERSION,
      buildId: "older",
      nuiBuildId: null,
      nuiReady: false,
    });
    expect(job.state).toBe("disconnected");
  });
  it("publishes bound progressive logs before completion without final duplicates", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    const log = { level: "info", message: "early" };
    const raw = JSON.stringify({ id: job.id, seq: 1, log });
    from(8, names.log, raw);
    expect(game.logs.read({ executionId: job.id }).lines).toHaveLength(0);
    from(7, names.log, raw);
    expect(job.state).toBe("running");
    expect(job.logs).toEqual([log]);
    expect(
      game.logs.read({
        executionId: job.id,
        channel: "dolu_fivem_mcp",
        level: "info",
      }).lines,
    ).toHaveLength(1);
    from(
      7,
      names.result,
      job.id,
      JSON.stringify({
        ok: true,
        values: [],
        logs: [log, { level: "warn", message: "final only" }],
        durationMs: 1,
      }),
    );
    expect(
      game.logs.read({ executionId: job.id }).lines.map((line) => line.message),
    ).toEqual(["early", "final only"]);
    expect(job.outcome?.logs).toHaveLength(2);
    from(7, names.log, JSON.stringify({ id: job.id, seq: 3, log }));
    expect(game.logs.read({ executionId: job.id }).lines).toHaveLength(2);
  });
  it("rejects malformed, oversized, duplicate, reordered and excessive logs with bounded audit", async () => {
    hello(7);
    const job = await game.execute("client", input, 7);
    const packet = (seq: number, message = "line") =>
      JSON.stringify({ id: job.id, seq, log: { level: "info", message } });
    for (const raw of [
      "{",
      "x".repeat(25_001),
      packet(0),
      packet(2),
      packet(1, "x".repeat(4097)),
      JSON.stringify({
        id: job.id,
        seq: 1,
        log: { level: "invalid", message: "x" },
      }),
    ])
      from(7, names.log, raw);
    expect(job.logs).toHaveLength(0);
    from(7, names.log, packet(1));
    from(7, names.log, packet(1));
    for (let seq = 2; seq <= 102; seq++) from(7, names.log, packet(seq));
    expect(job.logs).toHaveLength(100);
    expect(
      game.logs.read({ source: "audit", contains: "Rejected" }).lines,
    ).toHaveLength(1);
  });
  it.each(["revocation", "disconnect", "timeout"])(
    "preserves progressive logs after %s and rejects late outcomes",
    async (reason) => {
      hello(7);
      const job = await game.execute("client", input, 7);
      const log = { level: "info", message: "retained" };
      from(7, names.log, JSON.stringify({ id: job.id, seq: 1, log }));
      if (reason === "revocation") {
        authorized.delete(7);
        from(7, names.log, JSON.stringify({ id: job.id, seq: 2, log }));
      } else if (reason === "disconnect") {
        from(7, "playerDropped");
      } else {
        const now = vi
          .spyOn(Date, "now")
          .mockReturnValue(Date.parse(job.startedAt) + input.timeoutMs);
        from(7, names.log, JSON.stringify({ id: job.id, seq: 2, log }));
        now.mockRestore();
      }
      from(
        7,
        names.result,
        job.id,
        JSON.stringify({ ok: true, values: [], logs: [log], durationMs: 1 }),
      );
      expect(job.state).not.toBe("completed");
      expect(job.logs).toEqual([log]);
      expect(game.logs.read({ executionId: job.id }).lines).toHaveLength(1);
    },
  );
  it("streams both server JavaScript and Lua logs while running", async () => {
    const js = await game.execute("server", {
      ...input,
      language: "javascript",
      code: "ctx.log('js early'); await ctx.sleep(500); return 1",
    });
    expect(js.state).toBe("running");
    expect(game.logs.read({ executionId: js.id }).lines[0]?.message).toBe(
      "js early",
    );
    const lua = await game.execute("server", input);
    handlers.get(names.luaLog)?.(
      JSON.stringify({
        id: lua.id,
        seq: 1,
        log: { level: "info", message: "lua early" },
      }),
    );
    expect(lua.state).toBe("running");
    expect(game.logs.read({ executionId: lua.id }).lines[0]?.message).toBe(
      "lua early",
    );
    handlers.get(names.luaLog)?.(
      JSON.stringify({
        id: js.id,
        seq: 2,
        log: { level: "info", message: "wrong language" },
      }),
    );
    expect(js.logs).toHaveLength(1);
  });
  it("bounds inbound packet rate per player and allows recovery next second", async () => {
    hello(7);
    const job = await game.execute("client", { ...input, timeoutMs: 5000 }, 7);
    for (let i = 0; i < 200; i++) from(7, names.log, "{}");
    const packet = JSON.stringify({
      id: job.id,
      seq: 1,
      log: { level: "info", message: "recovered" },
    });
    from(7, names.log, packet);
    expect(job.logs).toHaveLength(0);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
    try {
      from(7, names.log, packet);
      expect(job.logs).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
  it("deduplicates scoped server console echoes while retaining ordinary console output", async () => {
    const job = await game.execute("server", input);
    const log = { level: "info", message: "early" };
    handlers.get(names.luaLog)?.(JSON.stringify({ id: job.id, seq: 1, log }));
    handlers.get("console")?.("script:dolu_fivem_mcp", `[dolu_fivem_mcp][${job.id}] early`);
    handlers.get("console")?.("other", `Execution mentioned [${job.id}]`);
    handlers.get(names.luaResult)?.(
      job.id,
      JSON.stringify({ ok: true, values: [], logs: [log], durationMs: 1 }),
    );
    expect(game.logs.read({ executionId: job.id }).lines).toHaveLength(1);
    expect(game.logs.read({ source: "server" }).lines).toHaveLength(2);
  });
  it("cancels only the awaited job on abort and detaches the listener on completion", async () => {
    hello(7);
    const other = await game.execute("client", input, 7);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = game.execute(
      "client",
      { ...input, wait: true },
      7,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const job = game.jobs.list().find((item) => item.id !== other.id)!;
    from(
      7,
      names.log,
      JSON.stringify({
        id: job.id,
        seq: 1,
        log: { level: "info", message: "before abort" },
      }),
    );
    controller.abort();
    expect(await waiting).toMatchObject({
      id: job.id,
      state: "cancelled",
      logs: [{ message: "before abort" }],
    });
    expect(other.state).toBe("running");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    await new Promise((resolve) => setImmediate(resolve));
    expect(network).toHaveBeenCalledWith(names.cancel, 7, job.id);
    expect(network).not.toHaveBeenCalledWith(names.cancel, 7, other.id);
  });
  it("rejects pre-dispatch abortion but does not attach a lifetime signal to detached jobs", async () => {
    hello(7);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      game.execute("client", input, 7, aborted.signal),
    ).rejects.toThrow();
    expect(game.jobs.list()).toHaveLength(0);
    const duringQueue = new AbortController();
    const queued = game.execute("client", input, 7, duringQueue.signal);
    duringQueue.abort();
    await expect(queued).rejects.toThrow();
    expect(game.jobs.list()).toHaveLength(0);
    const detached = new AbortController();
    const add = vi.spyOn(detached.signal, "addEventListener");
    const job = await game.execute("client", input, 7, detached.signal);
    detached.abort();
    expect(job.state).toBe("running");
    expect(add).not.toHaveBeenCalled();
  });
  it("detaches an awaited execution abort listener after normal completion", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const job = await game.execute(
      "server",
      { ...input, language: "javascript", wait: true },
      undefined,
      controller.signal,
    );
    expect(job.state).toBe("completed");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(job.state).toBe("completed");
  });
});
