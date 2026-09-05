import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioRunner, scenarioSchema } from "../src/server/scenarios";
import type { CallToolResult } from "@modelcontextprotocol/server";

const runners: ScenarioRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.close();
  vi.restoreAllMocks();
});
function setup() {
  const runner = new ScenarioRunner();
  runners.push(runner);
  const invoke = vi.fn<
    (
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<CallToolResult>
  >(async () => ({
    content: [],
    structuredContent: { result: { answer: 42, text: "hello world" } },
  }));
  const args = scenarioSchema.parse({
    name: "smoke",
    resource: "dolu_fivem_mcp_test",
    playerId: 7,
    steps: [
      {
        label: "read",
        tool: "execute_client",
        arguments: { language: "javascript", code: "return 42" },
      },
    ],
  });
  return { runner, invoke, args, signal: new AbortController().signal };
}
describe("bounded scenario runner", () => {
  it("rejects assertions that could silently pass with missing expected data", () => {
    const { args } = setup();
    expect(
      scenarioSchema.safeParse({
        ...args,
        steps: [
          {
            ...args.steps[0],
            assertions: [{ path: ["missing"], operator: "equals" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      scenarioSchema.safeParse({
        ...args,
        steps: [
          {
            ...args.steps[0],
            assertions: [{ path: [], operator: "contains", expected: 42 }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("validates later step schemas before dispatching earlier effects", async () => {
    const { runner, invoke, args, signal } = setup();
    args.cleanup = [
      { ...args.steps[0]!, label: "invalid", arguments: { code: 42 } },
    ];
    const validate = vi.fn(
      (_name: string, parameters: Record<string, unknown>) => {
        if (typeof parameters.code !== "string")
          throw new Error("Code must be a string");
      },
    );
    await expect(runner.run(args, invoke, signal, validate)).rejects.toThrow(
      "Code must be a string",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not attach client identity to server-local entity inspection", async () => {
    const { runner, invoke, args, signal } = setup();
    args.steps = [
      {
        label: "inspect",
        tool: "inspect_entity",
        arguments: { target: "server", handle: 1 },
        assertions: [],
      },
    ];
    await runner.run(args, invoke, signal);
    expect(invoke).toHaveBeenCalledWith(
      "inspect_entity",
      { target: "server", handle: 1 },
      expect.any(AbortSignal),
    );
  });
  it("runs scoped steps, assertions and ordered cleanup", async () => {
    const { runner, invoke, args, signal } = setup();
    args.steps[0]!.assertions = [
      { path: ["answer"], operator: "equals", expected: 42 },
      { path: ["text"], operator: "contains", expected: "world" },
      { path: ["answer"], operator: "exists" },
    ];
    args.cleanup = [
      {
        label: "cleanup",
        tool: "execute_client",
        arguments: { language: "javascript", code: "return true" },
        assertions: [],
      },
    ];
    const report = await runner.run(args, invoke, signal);
    expect(report.state).toBe("passed");
    expect(report.cleanup[0]!.state).toBe("passed");
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "execute_client",
      expect.objectContaining({ playerId: 7 }),
      expect.any(AbortSignal),
    );
    expect(runner.get(report.id)).toEqual(report);
    expect(runner.list()[0]).toMatchObject({
      id: report.id,
      steps: 1,
      cleanup: 1,
    });
  });
  it("stops on failed assertions, marks remaining work unverified, still cleans up", async () => {
    const { runner, invoke, args, signal } = setup();
    args.steps[0]!.assertions = [
      { path: ["answer"], operator: "equals", expected: 99 },
    ];
    args.steps.push({ ...args.steps[0]!, label: "never dispatched" });
    args.cleanup = [{ ...args.steps[0]!, label: "cleanup", assertions: [] }];
    const report = await runner.run(args, invoke, signal);
    expect(report.state).toBe("failed");
    expect(report.steps.map((step) => step.state)).toEqual([
      "failed",
      "not_verified",
    ]);
    expect(report.cleanup[0]!.state).toBe("passed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("does not retry tool errors or hide cleanup failures", async () => {
    const { runner, invoke, args, signal } = setup();
    invoke.mockResolvedValue({
      isError: true,
      content: [],
      structuredContent: { result: { error: "no access" } },
    });
    args.cleanup = [{ ...args.steps[0]! }];
    const report = await runner.run(args, invoke, signal);
    expect(report.steps[0]!.error).toContain("no access");
    expect(report.cleanup[0]!.state).toBe("failed");
    expect(report.state).toBe("failed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each([{ resource: "other" }, { playerId: 8 }, { wait: false }])(
    "validates all targets before dispatch %j",
    async (invalid) => {
      const { runner, invoke, args, signal } = setup();
      args.cleanup = [{ ...args.steps[0]!, arguments: invalid }];
      await expect(runner.run(args, invoke, signal)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    },
  );
  it("rejects recursive or console steps and unscoped refresh", async () => {
    const { runner, invoke, args, signal } = setup();
    expect(
      scenarioSchema.safeParse({
        ...args,
        steps: [{ label: "bad", tool: "run_scenario" }],
      }).success,
    ).toBe(false);
    expect(
      scenarioSchema.safeParse({
        ...args,
        steps: [{ label: "bad", tool: "execute_command" }],
      }).success,
    ).toBe(false);
    args.steps = [
      {
        label: "bad",
        tool: "manage_resource",
        arguments: { action: "refresh" },
        assertions: [],
      },
    ];
    await expect(runner.run(args, invoke, signal)).rejects.toThrow("refresh");
  });
  it("handles caller cancellation and uses an independent cleanup budget", async () => {
    const { runner, invoke, args } = setup();
    const controller = new AbortController();
    invoke.mockImplementationOnce(async () => {
      controller.abort();
      return new Promise(() => {});
    });
    args.cleanup = [{ ...args.steps[0]! }];
    const report = await runner.run(args, invoke, controller.signal);
    expect(report.state).toBe("cancelled");
    expect(report.cleanup[0]!.state).toBe("passed");
    expect(invoke.mock.calls[1]![2].aborted).toBe(false);
  });
  it("refuses concurrent runs and closed reuse", async () => {
    const { runner, invoke, args } = setup();
    const controller = new AbortController();
    invoke.mockImplementationOnce(async () => new Promise(() => {}));
    const first = runner.run(args, invoke, controller.signal);
    await expect(runner.run(args, invoke, controller.signal)).rejects.toThrow(
      "already running",
    );
    controller.abort();
    await first;
    runner.close();
    await expect(runner.run(args, invoke, controller.signal)).rejects.toThrow(
      "closed",
    );
  });
  it("keeps a report running and undeletable until cleanup finishes", async () => {
    const { runner, invoke, args, signal } = setup();
    args.cleanup = [{ ...args.steps[0]! }];
    let release!: () => void;
    let entered!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    invoke.mockImplementationOnce(async () => ({ content: [] }));
    invoke.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { content: [] };
    });
    const running = runner.run(args, invoke, signal);
    await cleanupStarted;
    const id = runner.list()[0]!.id;
    expect(runner.get(id).state).toBe("running");
    expect(() => runner.remove(id)).toThrow("running");
    release();
    expect((await running).state).toBe("passed");
  });
  it("stores image evidence separately and removes it with its report", async () => {
    const { runner, invoke, args, signal } = setup();
    invoke.mockResolvedValue({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { result: { width: 10 } },
    });
    args.steps[0]!.tool = "game_screenshot";
    const report = await runner.run(args, invoke, signal);
    const evidenceId = report.steps[0]!.evidenceId!;
    expect(runner.getEvidence(evidenceId)).toMatchObject({
      content: [{ type: "image", data: "AAAA" }],
    });
    expect(JSON.stringify(report)).not.toContain("AAAA");
    runner.remove(report.id);
    expect(() => runner.getEvidence(evidenceId)).toThrow("expired");
  });
  it("bounds result retention and expires reports after fifteen minutes", async () => {
    const { runner, invoke, args, signal } = setup();
    invoke.mockResolvedValue({
      content: [],
      structuredContent: { result: "x".repeat(20000) },
    });
    const report = await runner.run(args, invoke, signal);
    expect(report.steps[0]!.result).toMatchObject({ truncated: true });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 900001);
    expect(() => runner.get(report.id)).toThrow("expired");
  });
  it("rejects oversized image evidence explicitly", async () => {
    const { runner, invoke, args, signal } = setup();
    invoke.mockResolvedValue({
      content: [
        { type: "image", data: "a".repeat(2097153), mimeType: "image/png" },
      ],
    });
    const report = await runner.run(args, invoke, signal);
    expect(report.steps[0]!.error).toContain("budget");
  });
});
