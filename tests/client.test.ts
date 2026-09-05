import { build } from "esbuild";
import { createContext, runInContext, type Context } from "node:vm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/shared/protocol";

describe("bundled client in a Node-free FiveM-like V8 context", () => {
  let bundle: string;
  let context: Context;
  let handlers: Map<string, (...args: unknown[]) => void>;
  const network = vi.fn();
  const names = events("dolu_fivem_mcp");
  const request = {
    id: "66fb06e7-6702-4331-8117-81ad4cae69c2",
    language: "javascript",
    code: "return PlayerPedId()",
    timeoutMs: 1000,
    buildId: "development",
  };
  beforeAll(async () => {
    const output = await build({
      entryPoints: ["src/client/index.ts"],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "iife",
      target: "es2020",
    });
    bundle = output.outputFiles[0]!.text;
  });
  beforeEach(() => {
    handlers = new Map();
    context = createContext({
      exports: {},
      source: 65535,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: vi.fn(),
      GetCurrentResourceName: () => "dolu_fivem_mcp",
      PlayerPedId: () => 42,
      console: {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      on: (name: string, callback: (...args: unknown[]) => void) =>
        handlers.set(name, callback),
      onNet: (name: string, callback: (...args: unknown[]) => void) =>
        handlers.set(name, callback),
      emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
      emitNet: network,
      RegisterNuiCallbackType: vi.fn(),
    });
    runInContext(bundle, context);
    network.mockClear();
  });
  it("runs JavaScript with natives and no require/DOM dependency", async () => {
    handlers.get(names.execute)?.(JSON.stringify(request));
    await vi.waitFor(() =>
      expect(network).toHaveBeenCalledWith(
        names.result,
        request.id,
        expect.any(String),
      ),
    );
    const returned = network.mock.calls.find(
      (args) => args[0] === names.result,
    );
    expect(JSON.parse(returned![2])).toMatchObject({ ok: true, values: [42] });
    expect(context.require).toBeUndefined();
    expect(context.document).toBeUndefined();
  });
  it("rejects local events pretending to be server execution requests", async () => {
    context.source = 0;
    handlers.get(names.execute)?.(JSON.stringify(request));
    await new Promise((resolve) => setImmediate(resolve));
    expect(network).not.toHaveBeenCalled();
  });
  it("routes Lua locally and returns its validated result", () => {
    handlers.set(names.luaExecute, (raw) => {
      expect(JSON.parse(String(raw)).language).toBe("lua");
      handlers.get(names.luaResult)?.(
        request.id,
        JSON.stringify({ ok: true, values: [9], logs: [], durationMs: 0 }),
      );
    });
    handlers.get(names.execute)?.(
      JSON.stringify({ ...request, language: "lua" }),
    );
    expect(JSON.parse(network.mock.calls[0]![2])).toMatchObject({
      values: [9],
    });
  });
  it("fails fast when client concurrency is exhausted", () => {
    for (let i = 0; i < 9; i++) {
      handlers.get(names.execute)?.(
        JSON.stringify({
          ...request,
          language: "lua",
          id: `66fb06e7-6702-4331-8117-${String(i).padStart(12, "0")}`,
        }),
      );
    }
    expect(network).toHaveBeenCalledOnce();
    expect(JSON.parse(network.mock.calls[0]![2])).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
    handlers.get("onClientResourceStop")?.("dolu_fivem_mcp");
  });
  it("requires matching server and NUI build identities", () => {
    handlers.get(names.execute)?.(
      JSON.stringify({ ...request, buildId: "old" }),
    );
    expect(JSON.parse(network.mock.calls[0]![2]).error).toContain(
      "build mismatch",
    );
    const cb = vi.fn();
    handlers.get("__cfx_nui:mcp_ready")?.({}, cb);
    expect(cb).toHaveBeenLastCalledWith({ ok: false, buildId: "development" });
    handlers.get("__cfx_nui:mcp_ready")?.({ buildId: "development" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ ok: true, buildId: "development" });
    expect(network).toHaveBeenLastCalledWith(names.hello, {
      version: "0.1.0",
      buildId: "development",
      nuiBuildId: "development",
      nuiReady: true,
    });
  });
  it("emits JavaScript logs immediately then stops them on cancellation", async () => {
    handlers.get(names.execute)?.(
      JSON.stringify({
        ...request,
        code: "ctx.log('early'); await ctx.sleep(500); ctx.log('late')",
      }),
    );
    expect(network.mock.calls[0]?.[0]).toBe(names.log);
    expect(JSON.parse(network.mock.calls[0]![1])).toMatchObject({
      id: request.id,
      seq: 1,
      log: { message: "early" },
    });
    expect(network.mock.calls.some((args) => args[0] === names.result)).toBe(
      false,
    );
    handlers.get(names.cancel)?.(request.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      network.mock.calls.filter((args) => args[0] === names.log),
    ).toHaveLength(1);
    expect(network.mock.calls.some((args) => args[0] === names.result)).toBe(
      false,
    );
  });
  it("validates Lua progression binding, size, sequence and lifecycle", () => {
    handlers.get(names.execute)?.(
      JSON.stringify({ ...request, language: "lua" }),
    );
    const packet = (seq: number) =>
      JSON.stringify({
        id: request.id,
        seq,
        log: { level: "info", message: "early" },
      });
    handlers.get(names.luaLog)?.("x".repeat(25_001));
    handlers.get(names.luaLog)?.(packet(2));
    handlers.get(names.luaLog)?.(packet(1));
    handlers.get(names.luaLog)?.(packet(1));
    expect(
      network.mock.calls.filter((args) => args[0] === names.log),
    ).toHaveLength(1);
    handlers.get(names.cancel)?.(request.id);
    handlers.get(names.luaLog)?.(packet(2));
    expect(
      network.mock.calls.filter((args) => args[0] === names.log),
    ).toHaveLength(1);
  });
});
