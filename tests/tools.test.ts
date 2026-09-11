import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpEndpoint } from "../src/server/http";
import { createTools } from "../src/server/tools";
import { GameService } from "../src/server/game";
import { z } from "zod";
import { ScenarioRunner } from "../src/server/scenarios";
import type { NuiDebugger } from "../src/server/nui";

describe("complete MCP tool surface", () => {
  let game: GameService;
  let endpoint: ReturnType<typeof createHttpEndpoint>;
  let url: string;
  let scenarios: ScenarioRunner;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const nui = {
    frames: vi.fn(async () => []),
    evaluate: vi.fn(async () => ({ result: 42 })),
    snapshot: vi.fn(async () => ({ elements: [] })),
    click: vi.fn(async () => ({ clicked: true })),
    interact: vi.fn<NuiDebugger["interact"]>(),
    waitFor: vi.fn<NuiDebugger["waitFor"]>(),
    startObservation: vi.fn<NuiDebugger["startObservation"]>(),
    readObservation: vi.fn<NuiDebugger["readObservation"]>(),
    stopObservation: vi.fn<NuiDebugger["stopObservation"]>(),
    listObservations: vi.fn<NuiDebugger["listObservations"]>(),
    screenshot: vi.fn(async () => "png"),
    gameScreenshot: vi.fn(async () => ({
      data: "/9j/AAAA",
      mimeType: "image/jpeg" as const,
      width: 1280,
      height: 720,
      capturedAt: "2026-09-05T00:00:00.000Z",
      includeNui: false,
      cefTargetId: "root",
    })),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("exports", {});
    vi.stubGlobal("require", () => {});
    vi.stubGlobal("RegisterConsoleListener", () => {});
    vi.stubGlobal("onNet", () => {});
    vi.stubGlobal("on", () => {});
    vi.stubGlobal("emit", () => {});
    vi.stubGlobal("IsPlayerAceAllowed", () => false);
    vi.stubGlobal("getPlayers", () => []);
    vi.stubGlobal("GetNumResources", () => 1);
    vi.stubGlobal("GetResourceByFindIndex", () => "dolu_fivem_mcp");
    vi.stubGlobal("GetResourceState", () => "started");
    game = new GameService("dolu_fivem_mcp", {
      port: 3210,
      ace: "dolu_fivem_mcp.use",
      cdpPort: 13172,
      cdpPlayer: 0,
      maxActive: 8,
    });
    scenarios = new ScenarioRunner();
    endpoint = createHttpEndpoint({
      port: 0,
      createMcp: () => createTools(game, nui, scenarios),
      log: () => {},
    });
    await endpoint.listen();
    const address = endpoint.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });
  afterEach(async () => {
    scenarios.close();
    game.close();
    await endpoint.close();
    await new Promise((resolve) => setImmediate(resolve));
    vi.unstubAllGlobals();
  });
  async function rpc(method: string, params: unknown = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  it("registers all tools, guide and development prompt", async () => {
    expect(
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "release-test", version: "1.0.0" },
      }),
    ).toMatchObject({
      result: { serverInfo: { name: "dolu_fivem_mcp" } },
    });
    expect(
      await (await fetch(url.replace(/\/mcp$/, "/health"))).json(),
    ).toEqual({
      ok: true,
      name: "dolu_fivem_mcp",
    });
    const list = z
      .object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      })
      .parse(await rpc("tools/list"));
    expect(list.result.tools).toHaveLength(35);
    expect(
      list.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("execute_nui");
    expect(list.result.tools.map((tool) => tool.name)).toContain(
      "game_screenshot",
    );
    const resources = await rpc("resources/list");
    expect(resources).toMatchObject({
      result: {
        resources: [{ uri: "fivem://dolu_fivem_mcp/execution-guide" }],
      },
    });
    expect(await rpc("prompts/list")).toMatchObject({
      result: { prompts: [{ name: "test_resource" }] },
    });
    const guide = await rpc("resources/read", {
      uri: "fivem://dolu_fivem_mcp/execution-guide",
    });
    expect(guide).toMatchObject({
      result: { contents: [{ text: expect.stringContaining("cooperative") }] },
    });
  });
  it("filters resource discovery without changing the unfiltered response", async () => {
    const resources = [
      { name: "dolu_mcp", state: "started" },
      { name: "dolu_settings", state: "stopped" },
      { name: "chat", state: "started" },
    ];
    vi.stubGlobal("GetNumResources", () => resources.length);
    vi.stubGlobal(
      "GetResourceByFindIndex",
      (index: number) => resources[index]?.name,
    );
    vi.stubGlobal(
      "GetResourceState",
      (name: string) => resources.find((entry) => entry.name === name)?.state,
    );
    for (const [args, expected] of [
      [{}, [resources[2], resources[0], resources[1]]],
      [{ name: "DOLU" }, resources.slice(0, 2)],
      [{ state: "started" }, [resources[2], resources[0]]],
      [{ name: "DOLU", state: "started" }, [resources[0]]],
      [{ name: "absent" }, []],
    ] as const) {
      expect(
        await rpc("tools/call", { name: "list_resources", arguments: args }),
      ).toMatchObject({
        result: { isError: false, structuredContent: { result: expected } },
      });
    }
  });
  it("routes bounded snapshot options and rejects invalid limits before CEF", async () => {
    vi.spyOn(game, "assertLocalNui").mockResolvedValue(1);
    expect(
      await rpc("tools/call", {
        name: "nui_snapshot",
        arguments: {
          resource: "example",
          selector: "#menu",
          maxElements: 5,
          includeText: false,
        },
      }),
    ).toMatchObject({ result: { isError: false } });
    expect(nui.snapshot).toHaveBeenCalledWith("example", undefined, {
      selector: "#menu",
      maxElements: 5,
      includeText: false,
    });
    nui.snapshot.mockClear();
    expect(
      await rpc("tools/call", {
        name: "nui_snapshot",
        arguments: { resource: "example", maxElements: 151 },
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(nui.snapshot).not.toHaveBeenCalled();
  });
  it("executes JS end-to-end through HTTP and exposes structured output", async () => {
    const response = await rpc("tools/call", {
      name: "execute_server",
      arguments: {
        language: "javascript",
        code: "return { answer: 42 }",
      },
    });
    expect(response).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          result: { state: "completed", outcome: { values: [{ answer: 42 }] } },
        },
      },
    });
  });
  it("waits for an existing job through HTTP without launching it again", async () => {
    const { job } = game.jobs.start(
      "server",
      {
        language: "javascript",
        code: "return 42",
        timeoutMs: 1000,
        wait: false,
      },
      undefined,
      vi.fn(),
      vi.fn(),
    );
    const originalWait = game.jobs.wait.bind(game.jobs);
    const wait = vi
      .spyOn(game.jobs, "wait")
      .mockImplementation((id, waitMs, signal) => {
        const pending = originalWait(id, waitMs, signal);
        game.jobs.finish(id, {
          ok: true,
          values: [42],
          logs: [],
          durationMs: 1,
        });
        return pending;
      });
    expect(
      await rpc("tools/call", {
        name: "get_execution",
        arguments: { id: job.id, waitMs: 500, compact: true },
      }),
    ).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          result: { id: job.id, state: "completed", outcome: { values: [42] } },
        },
      },
    });
    expect(wait).toHaveBeenCalledWith(job.id, 500, expect.any(AbortSignal));
    expect(game.jobs.list()).toHaveLength(1);
  });
  it("compacts execution logs without losing values, errors or stored details", async () => {
    const { job } = game.jobs.start(
      "server",
      {
        language: "javascript",
        code: "return 42",
        timeoutMs: 1000,
        wait: false,
      },
      undefined,
      vi.fn(),
      vi.fn(),
    );
    const logs = Array.from({ length: 100 }, () => ({
      level: "info" as const,
      message: "x".repeat(1024),
    }));
    game.jobs.finish(job.id, {
      ok: false,
      values: [42],
      logs,
      durationMs: 1,
      error: "expected failure",
    });
    const full = await rpc("tools/call", {
      name: "get_execution",
      arguments: { id: job.id },
    });
    const compact = await rpc("tools/call", {
      name: "get_execution",
      arguments: { id: job.id, compact: true },
    });
    expect(compact).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          result: {
            state: "failed",
            logCount: 100,
            outcome: { values: [42], error: "expected failure" },
          },
        },
      },
    });
    expect(compact.result.structuredContent.result).not.toHaveProperty("logs");
    expect(compact.result.structuredContent.result.outcome).not.toHaveProperty(
      "logs",
    );
    expect(full.result.structuredContent.result.logs).toHaveLength(100);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(full).length * 0.05,
    );
    expect(game.jobs.get(job.id).outcome?.logs).toHaveLength(100);
    const list = await rpc("tools/call", {
      name: "list_executions",
      arguments: { compact: true },
    });
    expect(list.result.structuredContent.result[0]).toMatchObject({
      id: job.id,
      logCount: 100,
      ok: false,
    });
    expect(list.result.structuredContent.result[0]).not.toHaveProperty("logs");
  });
  it.each(["execute_server", "execute_client"])(
    "supports compact output from %s",
    async (name) => {
      const job = {
        id: "12345678-1234-4123-8123-123456789012",
        target: "server" as const,
        language: "javascript" as const,
        state: "completed" as const,
        startedAt: new Date().toISOString(),
        logs: [{ level: "info" as const, message: "hello" }],
        outcome: {
          ok: true,
          values: [42],
          logs: [{ level: "info" as const, message: "hello" }],
          durationMs: 1,
        },
      };
      vi.spyOn(game, "execute").mockResolvedValue(job);
      const response = await rpc("tools/call", {
        name,
        arguments: {
          language: "javascript",
          code: "return 42",
          compact: true,
        },
      });
      expect(response.result.structuredContent.result).toMatchObject({
        logCount: 1,
        outcome: { values: [42] },
      });
      expect(response.result.structuredContent.result).not.toHaveProperty(
        "logs",
      );
      expect(job.logs).toHaveLength(1);
    },
  );
  it("persists scenario reports across stateless requests", async () => {
    const response = await rpc("tools/call", {
      name: "run_scenario",
      arguments: {
        name: "HTTP smoke",
        resource: "dolu_fivem_mcp",
        steps: [
          {
            label: "calculation",
            tool: "execute_server",
            arguments: { language: "javascript", code: "return 42;" },
            assertions: [
              {
                path: ["outcome", "values", 0],
                operator: "equals",
                expected: 42,
              },
            ],
          },
        ],
      },
    });
    const parsed = z
      .object({
        result: z.object({
          structuredContent: z.object({
            result: z.object({ id: z.string(), state: z.literal("passed") }),
          }),
        }),
      })
      .parse(response);
    const id = parsed.result.structuredContent.result.id;
    expect(
      await rpc("tools/call", { name: "get_scenario", arguments: { id } }),
    ).toMatchObject({
      result: {
        isError: false,
        structuredContent: { result: { id, state: "passed" } },
      },
    });
    expect(
      await rpc("tools/call", { name: "delete_scenario", arguments: { id } }),
    ).toMatchObject({ result: { isError: false } });
    expect(
      await rpc("tools/call", { name: "get_scenario", arguments: { id } }),
    ).toMatchObject({ result: { isError: true } });
  });
  it("surfaces execution errors as MCP tool errors", async () => {
    const response = await rpc("tools/call", {
      name: "execute_server",
      arguments: {
        language: "javascript",
        code: "throw new Error('expected failure')",
      },
    });
    expect(response).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          result: {
            outcome: { error: expect.stringContaining("expected failure") },
          },
        },
      },
    });
  });
  it("does not access CEF without an authorized local client", async () => {
    const response = await rpc("tools/call", {
      name: "execute_nui",
      arguments: {
        resource: "example",
        code: "return 42",
      },
    });
    expect(response).toMatchObject({ result: { isError: true } });
    expect(nui.evaluate).not.toHaveBeenCalled();
  });
  it("wires filtered progressive logs to both read and wait", async () => {
    const executionId = "12345678-1234-4123-8123-123456789012";
    game.logs.add({
      executionId,
      source: "client",
      channel: "snippet",
      playerId: 7,
      level: "warn",
      message: "progress",
    });
    game.logs.add({
      source: "client",
      channel: "snippet",
      playerId: 7,
      level: "info",
      message: "progress",
    });
    for (const name of ["read_logs", "wait_for_log"]) {
      const response = await rpc("tools/call", {
        name,
        arguments: {
          executionId,
          channel: "snippet",
          level: "warn",
          contains: "progress",
          after: 0,
        },
      });
      expect(response).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            result: { lines: [{ executionId, level: "warn" }] },
          },
        },
      });
      const parsed = z
        .object({
          result: z.object({
            structuredContent: z.object({
              result: z.object({ lines: z.array(z.unknown()) }),
            }),
          }),
        })
        .parse(response);
      expect(parsed.result.structuredContent.result.lines).toHaveLength(1);
    }
  });
  it("validates and authorizes NUI interactions before dispatch", async () => {
    await rpc("tools/call", {
      name: "nui_interact",
      arguments: {
        resource: "test",
        interaction: { action: "fill", selector: "#name", text: "hello" },
      },
    });
    expect(nui.interact).not.toHaveBeenCalled();
    vi.spyOn(game, "assertLocalNui").mockResolvedValue(7);
    nui.interact.mockResolvedValue({ action: "fill" });
    expect(
      await rpc("tools/call", {
        name: "nui_interact",
        arguments: {
          playerId: 7,
          resource: "test",
          interaction: { action: "fill", selector: "#name", text: "hello" },
        },
      }),
    ).toMatchObject({ result: { isError: false } });
    expect(nui.interact).toHaveBeenCalledWith(
      "test",
      { action: "fill", selector: "#name", text: "hello" },
      undefined,
    );
  });
  it("binds observation authorization to the captured player across requests", async () => {
    const authorize = vi.spyOn(game, "assertLocalNui").mockResolvedValue(7);
    const entry = {
      id: "12345678-1234-4123-8123-123456789012",
      resource: "test",
      frameId: "frame",
      targetId: "target",
      playerId: 7,
      startedAt: "2026-09-05T00:00:00.000Z",
      expiresAt: "2026-09-05T00:00:10.000Z",
      status: "active" as const,
      error: undefined,
      count: 0,
      bytes: 0,
      dropped: 0,
      skipped: 0,
      truncated: false,
      firstCursor: 0,
      nextCursor: 0,
      semantics: "from-start",
    };
    nui.startObservation.mockResolvedValue(entry);
    expect(
      await rpc("tools/call", {
        name: "start_nui_observation",
        arguments: { resource: "test" },
      }),
    ).toMatchObject({ result: { isError: false } });
    const guard = nui.startObservation.mock.calls[0]![3]!;
    await guard();
    expect(authorize).toHaveBeenLastCalledWith(7);
    nui.readObservation.mockResolvedValue({
      ...entry,
      entries: [],
      cursor: 0,
      cursorDropped: 0,
    });
    expect(
      await rpc("tools/call", {
        name: "read_nui_observation",
        arguments: { id: entry.id },
      }),
    ).toMatchObject({ result: { isError: false } });
    authorize.mockResolvedValue(8);
    expect(
      await rpc("tools/call", {
        name: "read_nui_observation",
        arguments: { id: entry.id },
      }),
    ).toMatchObject({ result: { isError: true } });
    nui.listObservations.mockResolvedValue([entry]);
    expect(
      await rpc("tools/call", {
        name: "stop_nui_observation",
        arguments: { id: entry.id },
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(nui.stopObservation).not.toHaveBeenCalled();
  });
  it("gates game screenshots on the authorized local player", async () => {
    expect(
      await rpc("tools/call", {
        name: "game_screenshot",
        arguments: {},
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(nui.gameScreenshot).not.toHaveBeenCalled();
  });
  it("returns a native MCP image with metadata and bounded defaults", async () => {
    const local = vi.spyOn(game, "assertLocalNui").mockResolvedValue(7);
    const response = await rpc("tools/call", {
      name: "game_screenshot",
      arguments: { playerId: 7 },
    });
    expect(local).toHaveBeenCalledWith(7);
    expect(nui.gameScreenshot).toHaveBeenCalledWith("dolu_fivem_mcp", {
      includeNui: false,
      maxWidth: 1280,
      format: "jpeg",
      quality: 0.85,
    });
    expect(response).toMatchObject({
      result: {
        isError: false,
        content: [
          { type: "image", mimeType: "image/jpeg", data: "/9j/AAAA" },
          { type: "text" },
        ],
        structuredContent: {
          result: { playerId: 7, width: 1280, height: 720, includeNui: false },
        },
      },
    });
  });
  it("passes the requested overlay and never substitutes a raw image on failure", async () => {
    vi.spyOn(game, "assertLocalNui").mockResolvedValue(7);
    nui.gameScreenshot.mockRejectedValueOnce(new Error("CEF capture failed"));
    const response = await rpc("tools/call", {
      name: "game_screenshot",
      arguments: { includeNui: true, format: "png", maxWidth: 640 },
    });
    expect(nui.gameScreenshot).toHaveBeenCalledWith(
      "dolu_fivem_mcp",
      expect.objectContaining({
        includeNui: true,
        format: "png",
        maxWidth: 640,
      }),
    );
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text" }],
        structuredContent: {
          result: { error: expect.stringContaining("CEF capture failed") },
        },
      },
    });
  });
  it.each([{ maxWidth: 10000 }, { quality: 2 }, { format: "webp" }])(
    "rejects invalid game screenshot options %j before accessing CEF",
    async (args) => {
      expect(
        await rpc("tools/call", { name: "game_screenshot", arguments: args }),
      ).toMatchObject({ result: { isError: true } });
      expect(nui.gameScreenshot).not.toHaveBeenCalled();
    },
  );
});
