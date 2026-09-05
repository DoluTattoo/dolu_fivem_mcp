import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LuaFactory, type LuaEngine } from "wasmoon";

const code = readFileSync(
  new URL("../lua/executor.lua", import.meta.url),
  "utf8",
);
const harness = `
NOW = 0
HANDLERS = {}
THREADS = {}
function GetCurrentResourceName() return 'dolu_fivem_mcp' end
function GetGameTimer() return NOW end
function print(...) end
function AddEventHandler(name, fn) HANDLERS[name] = fn end
PROGRESS = {}
function TriggerEvent(name, id, raw)
    if name == 'dolu_fivem_mcp:mcp:lua:log' then PROGRESS[#PROGRESS + 1] = id
    else RESULT = raw end
end
function Wait(ms) coroutine.yield(ms) end
function CreateThread(fn)
    local co = coroutine.create(fn)
    THREADS[#THREADS + 1] = co
    local ok, err = coroutine.resume(co)
    if not ok then error(err) end
end
json = {}
function json.decode(_) return REQUEST end
function json.encode(value)
    local t = type(value)
    if t == 'nil' then return 'null' end
    if t == 'boolean' or t == 'number' then return tostring(value) end
    if t == 'string' then
        return '"' .. value:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"'):gsub('\\n', '\\\\n'):gsub('\\r', '\\\\r'):gsub('\\t', '\\\\t') .. '"'
    end
    local parts = {}
    for k, v in pairs(value) do parts[#parts + 1] = json.encode(tostring(k)) .. ':' .. json.encode(v) end
    return '{' .. table.concat(parts, ',') .. '}'
end
function RUN(source)
    RESULT = nil
    REQUEST = { id = 'test', code = source, timeoutMs = 1000 }
    HANDLERS['dolu_fivem_mcp:mcp:lua:execute']('{}')
end
`;

describe("Lua 5.4 executor with mocked FiveM scheduler", () => {
  let lua: LuaEngine;
  beforeEach(async () => {
    lua = await new LuaFactory().createEngine();
    await lua.doString(harness);
    await lua.doString(code);
  });
  afterEach(() => lua.global.close());
  async function run(source: string) {
    lua.global.set("INPUT", source);
    await lua.doString("RUN(INPUT)");
    const raw = lua.global.get("RESULT") as unknown;
    if (typeof raw !== "string") throw new Error("No Lua result");
    return JSON.parse(raw);
  }
  it("preserves nil and multiple return values and captures print", async () => {
    expect(await run("print('hello'); return 42, nil, 'ok'")).toMatchObject({
      ok: true,
      values: [42, { $type: "nil" }, "ok"],
      logs: [{ level: "info", message: "hello" }],
    });
  });
  it("returns real JSON arrays when there are no values or logs", async () => {
    expect(await run("return")).toMatchObject({
      ok: true,
      values: [],
      logs: [],
    });
  });
  it("does not attach an error to a successful return", async () => {
    expect((await run("return 42")).error).toBeUndefined();
  });
  it("reports compile and runtime errors", async () => {
    expect(await run("return )")).toMatchObject({ ok: false });
    expect(await run("error('boom')")).toMatchObject({
      ok: false,
      error: expect.stringContaining("boom"),
    });
  });
  it("runs cleanup and serializes cyclic tables", async () => {
    const result = await run(
      "ctx.onCleanup(function() CLEANED = true; _G.CLEANED = true end); local t = {}; t.self = t; return t",
    );
    expect(result.values).toEqual([{ self: { $type: "circular" } }]);
    expect(lua.global.get("CLEANED")).toBe(true);
  });
  it("supports yielding and cancellation without claiming success", async () => {
    lua.global.set("INPUT", "ctx.sleep(100); return 42");
    await lua.doString("RUN(INPUT)");
    expect(lua.global.get("RESULT")).toBeNull();
    await lua.doString(
      "HANDLERS['dolu_fivem_mcp:mcp:lua:cancel']('test'); NOW = 100; assert(coroutine.resume(THREADS[1]))",
    );
    expect(JSON.parse(lua.global.get("RESULT"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });
  it("stops a non-yielding loop when debug hooks are available", async () => {
    expect(await run("while true do end")).toMatchObject({
      ok: false,
      error: expect.stringContaining("budget"),
    });
  });
  it("emits sequenced print/ctx logs before completion and caps the stream", async () => {
    lua.global.set(
      "INPUT",
      "print('early'); ctx.sleep(100); ctx.log('later'); return 1",
    );
    await lua.doString("RUN(INPUT)");
    expect(lua.global.get("RESULT")).toBeNull();
    expect(JSON.parse(await lua.doString("return PROGRESS[1]"))).toMatchObject({
      id: "test",
      seq: 1,
      log: { level: "info", message: "early" },
    });
    await lua.doString("NOW = 100; assert(coroutine.resume(THREADS[1]))");
    expect(JSON.parse(await lua.doString("return PROGRESS[2]")).seq).toBe(2);
    expect(JSON.parse(lua.global.get("RESULT")).logs).toHaveLength(2);
    await lua.doString("PROGRESS = {}");
    await run("for i=1,200 do print(i) end");
    expect(await lua.doString("return #PROGRESS")).toBe(100);
  });
});
