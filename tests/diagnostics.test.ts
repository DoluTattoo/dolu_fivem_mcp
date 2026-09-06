import { describe, expect, it, vi } from "vitest";
import { diagnose } from "../src/server/diagnostics";
import type { GameService } from "../src/server/game";
import { runInNewContext } from "node:vm";
import { VERSION } from "../src/shared/protocol";

function fixture() {
  const player = {
    playerId: 7,
    name: "Tester",
    authorized: true,
    ready: true,
    readinessReasons: [] as string[],
    lastSeen: new Date().toISOString(),
    serverBuildId: "development",
    clientBuildId: "development",
    nuiBuildId: "development",
    bridgeVersion: VERSION,
    nuiReady: true,
    nuiReadinessReason: null,
  };
  const execute = vi
    .fn<GameService["execute"]>()
    .mockImplementation(async (_target, input) => ({
      id: "probe",
      target: "server",
      language: input.language,
      state: "completed",
      startedAt: new Date().toISOString(),
      logs: [],
      outcome: {
        ok: true,
        logs: [],
        durationMs: 1,
        values:
          input.language === "lua" ? ["dolu_fivem_mcp", 12] : [["dolu_fivem_mcp", 12]],
      },
    }));
  const game = {
    resource: "dolu_fivem_mcp",
    buildId: "development",
    execute,
    assertLocalNui: vi.fn().mockResolvedValue(7),
    players: vi.fn().mockResolvedValue([player]),
    runtimeInfo: vi.fn().mockResolvedValue({
      resource: "dolu_fivem_mcp",
      resourceState: "started",
      version: VERSION,
      buildId: "development",
      artifact: "test",
      node: "v22",
      platform: "win32",
      consoleAvailable: true,
      ace: "dolu_fivem_mcp.use",
      commandAces: {
        start: true,
        stop: true,
        restart: true,
        ensure: true,
        refresh: true,
      },
    }),
  };
  const nui = {
    evaluate: vi
      .fn<(resource: string, code: string) => Promise<unknown>>()
      .mockResolvedValue({
        buildId: "development",
        version: 1,
        captureAvailable: true,
      }),
    gameScreenshot: vi.fn().mockResolvedValue({ image: "not returned" }),
  };
  return { game, nui, player };
}
describe("read-safe layered diagnostics", () => {
  it("never executes snippets or captures images by default", async () => {
    const { game, nui } = fixture();
    const report = await diagnose(game, nui);
    expect(game.execute).not.toHaveBeenCalled();
    expect(nui.gameScreenshot).not.toHaveBeenCalled();
    expect(report.checks.find((check) => check.id === "capture")?.state).toBe(
      "not_tested",
    );
    expect(
      report.checks
        .filter((check) => check.id.endsWith("_native"))
        .every((check) => check.state === "not_tested"),
    ).toBe(true);
  });
  it("runs only bounded read-only native probes when requested", async () => {
    const { game, nui } = fixture();
    const report = await diagnose(game, nui, { playerId: 7, runChecks: true });
    expect(game.execute).toHaveBeenCalledTimes(4);
    for (const [, input] of game.execute.mock.calls) {
      expect(input.timeoutMs).toBe(1500);
      expect(input.wait).toBe(true);
      expect(input.code).toContain("GetGameTimer()");
    }
    expect(
      report.checks
        .filter((check) => check.id.endsWith("_native"))
        .every((check) => check.state === "pass"),
    ).toBe(true);
    expect(nui.gameScreenshot).not.toHaveBeenCalled();
  });
  it("reports unavailable clients/CDP and absent console without false successes", async () => {
    const { game, nui } = fixture();
    game.players.mockResolvedValue([]);
    nui.evaluate.mockRejectedValue(new Error("CDP offline"));
    game.runtimeInfo.mockResolvedValue({
      ...(await game.runtimeInfo()),
      consoleAvailable: false,
    });
    const report = await diagnose(game, nui, { runChecks: true, playerId: 8 });
    expect(
      report.checks.find((check) => check.id === "client_javascript_native")
        ?.state,
    ).toBe("unavailable");
    expect(
      report.checks.find((check) => check.id === "server_console")?.state,
    ).toBe("unavailable");
    expect(
      report.checks.find((check) => check.id === "cdp_bridge_capture")?.state,
    ).toBe("unavailable");
    expect(nui.evaluate).not.toHaveBeenCalled();
  });
  it("reports native failures and performs capture only after explicit consent", async () => {
    const { game, nui } = fixture();
    game.execute.mockImplementation(async (_target, input) => ({
      id: "failed",
      target: "server",
      language: input.language,
      state: "timed_out",
      startedAt: "",
      logs: [],
    }));
    nui.gameScreenshot.mockRejectedValue(new Error("No renderer"));
    const report = await diagnose(game, nui, {
      runChecks: true,
      capture: true,
    });
    expect(
      report.checks.find((check) => check.id === "server_lua_native")?.state,
    ).toBe("fail");
    expect(report.checks.find((check) => check.id === "capture")).toMatchObject(
      { state: "fail", reason: expect.stringContaining("No renderer") },
    );
    expect(nui.gameScreenshot).toHaveBeenCalledWith("dolu_fivem_mcp", {
      includeNui: false,
      maxWidth: 320,
      format: "jpeg",
      quality: 0.5,
    });
  });
  it("reports missing ACE, stale client builds, and adapter errors with remediation", async () => {
    const { game, nui, player } = fixture();
    game.players.mockResolvedValue([
      {
        ...player,
        authorized: false,
        ready: false,
        readinessReasons: ["missing_ace", "build_mismatch"],
      },
    ]);
    game.runtimeInfo.mockResolvedValue({
      ...(await game.runtimeInfo()),
      commandAces: { restart: false },
    });
    const report = await diagnose(game, nui, { playerId: 7 });
    expect(
      report.checks.find((check) => check.id === "client_readiness"),
    ).toMatchObject({ state: "fail", reason: "missing_ace, build_mismatch" });
    expect(
      report.checks.find((check) => check.id === "resource_ace"),
    ).toMatchObject({ state: "fail", remediation: expect.any(String) });
    game.players.mockResolvedValue([player]);
    nui.evaluate.mockRejectedValue(new Error("CDP offline"));
    expect(
      (await diagnose(game, nui)).checks.find(
        (check) => check.id === "cdp_bridge_capture",
      )?.state,
    ).toBe("unavailable");
  });
  it("distinguishes exposed capture capability from rendered capture and rejects stale bridge builds", async () => {
    const { game, nui } = fixture();
    nui.evaluate.mockResolvedValue({
      buildId: "stale",
      version: 1,
      captureAvailable: true,
    });
    let report = await diagnose(game, nui, { capture: true });
    expect(
      report.checks.find((check) => check.id === "cdp_bridge_capture")?.state,
    ).toBe("fail");
    expect(report.checks.find((check) => check.id === "capture")?.state).toBe(
      "unavailable",
    );
    expect(nui.gameScreenshot).not.toHaveBeenCalled();
    nui.evaluate.mockResolvedValue({
      buildId: "development",
      version: 1,
      captureAvailable: false,
    });
    report = await diagnose(game, nui);
    expect(
      report.checks.find((check) => check.id === "cdp_bridge_capture")?.state,
    ).toBe("unavailable");
    game.assertLocalNui.mockRejectedValue(new Error("Remote client"));
    nui.evaluate.mockClear();
    report = await diagnose(game, nui, { capture: true });
    expect(nui.evaluate).not.toHaveBeenCalled();
    expect(
      report.checks.find((check) => check.id === "cdp_bridge_capture")?.reason,
    ).toContain("Remote client");
  });
  it("inspects public bridge descriptors without invoking accessors or capture", async () => {
    const { game, nui } = fixture();
    nui.evaluate.mockImplementation(async (_resource, code) =>
      runInNewContext(`
        globalThis.doluMcpBuild = "development";
        globalThis.doluMcpCapture = { version: 1 };
        Object.defineProperty(doluMcpCapture, "capture", {
          get() { throw new Error("must not invoke capture getter"); }
        });
        (function () { ${code} })();
      `),
    );
    const report = await diagnose(game, nui);
    expect(
      report.checks.find((check) => check.id === "cdp_bridge_capture"),
    ).toMatchObject({
      state: "unavailable",
      details: { buildId: "development", version: 1, captureAvailable: false },
    });
    expect(nui.gameScreenshot).not.toHaveBeenCalled();
  });
});
