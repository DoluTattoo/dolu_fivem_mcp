import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/server/config";
import { Jobs } from "../src/server/jobs";
import { LogBuffer } from "../src/server/logs";
import { JavascriptExecutor } from "../src/shared/executor";
import { scheduleTimeout } from "../src/shared/timer";
import {
  encodeOutcome,
  executionSchema,
  sanitize,
  type ExecutionInput,
  type WireRequest,
} from "../src/shared/protocol";

const input: ExecutionInput = {
  language: "javascript",
  code: "return 42",
  timeoutMs: 1000,
  wait: true,
};
const request: WireRequest = {
  ...input,
  id: "66fb06e7-6702-4331-8117-81ad4cae69c2",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("configuration and wire boundaries", () => {
  it("starts with defaults and no secret configuration", () => {
    expect(readConfig((_name, fallback) => fallback).port).toBe(3210);
  });
  it("reads the public convar namespace and player permission", () => {
    const get = vi.fn((_name: string, fallback: string) => fallback);
    expect(readConfig(get).ace).toBe("dolu_fivem_mcp.use");
    expect(get.mock.calls.map(([name]) => name)).toEqual([
      "dolu_fivem_mcp_port",
      "dolu_fivem_mcp_ace",
      "dolu_fivem_mcp_cdp_port",
      "dolu_fivem_mcp_cdp_player",
      "dolu_fivem_mcp_max_active",
    ]);
  });
  it("reads defaults and rejects conflicting ports", () => {
    const get = (_name: string, fallback: string) => fallback;
    expect(readConfig(get).port).toBe(3210);
    expect(() =>
      readConfig((name, fallback) =>
        name.endsWith("_port") ? "3210" : get(name, fallback),
      ),
    ).toThrow("different ports");
  });
  it("requires a language and limits code and deadlines", () => {
    expect(executionSchema.safeParse({ code: "return 1" }).success).toBe(false);
    expect(executionSchema.safeParse({ ...input, timeoutMs: 0 }).success).toBe(
      false,
    );
    expect(
      executionSchema.safeParse({ ...input, code: "x".repeat(65537) }).success,
    ).toBe(false);
  });
});

describe("serialization", () => {
  it("preserves special values and handles cycles without invoking getters", () => {
    const object = { big: 123n, missing: undefined, self: {} };
    object.self = object;
    Object.defineProperty(object, "getter", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    expect(sanitize(object)).toMatchObject({
      big: { $type: "bigint", value: "123" },
      missing: { $type: "undefined" },
      self: { $type: "circular" },
      getter: { $type: "accessor" },
    });
  });
  it("bounds arrays, depth and outcome envelopes", () => {
    expect(sanitize(Array.from({ length: 102 }, () => 1))).toHaveLength(101);
    const raw = encodeOutcome({
      ok: true,
      values: ["x".repeat(150000)],
      logs: [],
      durationMs: 1,
    });
    expect(JSON.parse(raw)).toMatchObject({ ok: false, truncated: true });
  });
});

describe("JavaScript executor", () => {
  function executor() {
    return new JavascriptExecutor({
      resource: "dolu_fivem_mcp",
      exports: { test: true },
      print: vi.fn(),
      game: (fn) => Promise.resolve(fn()),
    });
  }
  it("supports await, ctx, exports, logs and return values", async () => {
    const run = executor();
    const outcome = await run.execute({
      ...request,
      code: "console.log('hello', 12); await ctx.sleep(1); return [await ctx.game(() => 42), exports.test, ctx.resource];",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.values).toEqual([[42, true, "dolu_fivem_mcp"]]);
    expect(outcome.logs).toEqual([{ level: "info", message: "hello 12" }]);
  });
  it("surfaces syntax/runtime errors and cleanup failures", async () => {
    const run = executor();
    expect((await run.execute({ ...request, code: "return }" })).ok).toBe(
      false,
    );
    expect(
      (await run.execute({ ...request, code: "throw new Error('boom')" }))
        .error,
    ).toContain("boom");
    expect(
      (
        await run.execute({
          ...request,
          code: "ctx.onCleanup(() => { throw new Error('cleanup'); }); return 1;",
        })
      ).error,
    ).toContain("Cleanup failed");
  });
  it("cancels sleeping work and executes cleanup", async () => {
    const cleaned = vi.fn();
    const run = new JavascriptExecutor({
      resource: "dolu_fivem_mcp",
      exports: { cleaned },
      print: vi.fn(),
    });
    const promise = run.execute({
      ...request,
      code: "ctx.onCleanup(exports.cleaned); await ctx.sleep(1000); return 'too late';",
    });
    run.cancel(request.id);
    expect((await promise).ok).toBe(false);
    expect(cleaned).toHaveBeenCalledOnce();
  });
  it("bounds captured logs", async () => {
    const outcome = await executor().execute({
      ...request,
      code: "for(let i=0;i<300;i++) console.log('line', i); return 1;",
    });
    expect(outcome.logs).toHaveLength(100);
  });
});

describe("execution lifecycle", () => {
  it("binds results to the intended player and ignores late completion", async () => {
    const jobs = new Jobs();
    const cancel = vi.fn();
    const { job, done } = jobs.start("client", input, 7, vi.fn(), cancel);
    expect(jobs.accepts(job.id, 8)).toBe(false);
    expect(jobs.accepts(job.id)).toBe(false);
    expect(jobs.accepts(job.id, 7)).toBe(true);
    jobs.disconnect(7);
    expect((await done).state).toBe("disconnected");
    expect(cancel).toHaveBeenCalledWith(job.id);
    expect(
      jobs.finish(job.id, { ok: true, values: [], logs: [], durationMs: 1 }),
    ).toBe(false);
  });
  it("times out and limits concurrency", async () => {
    vi.useFakeTimers();
    const jobs = new Jobs(1);
    const { done } = jobs.start("server", input, undefined, vi.fn(), vi.fn());
    expect(() =>
      jobs.start("server", input, undefined, vi.fn(), vi.fn()),
    ).toThrow("Too many");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).state).toBe("timed_out");
  });
  it("turns dispatch failures into explicit failed jobs", async () => {
    const jobs = new Jobs();
    const { done } = jobs.start(
      "server",
      input,
      undefined,
      () => {
        throw new Error("offline");
      },
      vi.fn(),
    );
    expect(await done).toMatchObject({
      state: "failed",
      outcome: { error: "offline" },
    });
  });
  it.each([true, false])(
    "expires late results before the timer callback (ok=%s)",
    async (ok) => {
      vi.useFakeTimers();
      const jobs = new Jobs();
      const cancel = vi.fn();
      const { job, done } = jobs.start("client", input, 7, vi.fn(), cancel);
      vi.setSystemTime(Date.now() + input.timeoutMs);
      expect(job.state).toBe("running");
      expect(
        jobs.finish(job.id, {
          ok,
          values: [],
          logs: [],
          durationMs: input.timeoutMs,
        }),
      ).toBe(false);
      expect((await done).state).toBe("timed_out");
      expect(job.outcome).toBeUndefined();
      expect(cancel).toHaveBeenCalledWith(job.id);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("early FiveM timer callbacks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const timer = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (callback: () => void, ms: number) =>
      timer(callback, Math.max(1, ms - 50)),
    );
  });

  it("rechecks the deadline and can cancel a rearmed timer", async () => {
    const callback = vi.fn();
    scheduleTimeout(callback, 150);
    await vi.advanceTimersByTimeAsync(149);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledOnce();

    const stop = scheduleTimeout(callback, 150);
    await vi.advanceTimersByTimeAsync(100);
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not shorten ctx.sleep or leak its deadline timer", async () => {
    const run = new JavascriptExecutor({
      resource: "dolu_fivem_mcp",
      exports: {},
      print: vi.fn(),
    });
    const completed = vi.fn();
    const outcome = run.execute({
      ...request,
      code: "await ctx.sleep(150); return 42;",
    });
    void outcome.then(completed);
    await vi.advanceTimersByTimeAsync(149);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      ok: true,
      values: [42],
      durationMs: 150,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expire the executor before its requested timeout", async () => {
    const run = new JavascriptExecutor({
      resource: "dolu_fivem_mcp",
      exports: {},
      print: vi.fn(),
    });
    const completed = vi.fn();
    const outcome = run.execute({
      ...request,
      timeoutMs: 500,
      code: "await ctx.sleep(1000); return 'late';",
    });
    void outcome.then(completed);
    await vi.advanceTimersByTimeAsync(499);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ ok: false, durationMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expire a job early and still rejects late completion", async () => {
    const jobs = new Jobs();
    const cancel = vi.fn();
    const { job, done } = jobs.start(
      "client",
      { ...input, timeoutMs: 500 },
      7,
      vi.fn(),
      cancel,
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(job.state).toBe("running");
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).state).toBe("timed_out");
    expect(cancel).toHaveBeenCalledWith(job.id);
    expect(
      jobs.finish(job.id, { ok: true, values: [], logs: [], durationMs: 501 }),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded log cursor", () => {
  it("bounds history and pages without skipping matching lines", () => {
    const logs = new LogBuffer(3);
    for (let i = 0; i < 5; i++)
      logs.add({
        source: "server",
        channel: "test",
        level: "info",
        message: `line ${i}`,
      });
    const page = logs.read({ after: 0, limit: 1 });
    expect(page.dropped).toBe(true);
    expect(page.lines[0]?.message).toBe("line 2");
    expect(page.hasMore).toBe(true);
    expect(logs.read({ after: page.nextCursor }).lines).toHaveLength(2);
  });
});
