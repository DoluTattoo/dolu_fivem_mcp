import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("./fixtures/dolu_fivem_mcp_test/client.js", import.meta.url),
  "utf8",
);

function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const focus = vi.fn();
  runInNewContext(source, {
    RegisterNuiCallbackType: vi.fn(),
    on: (name: string, handler: (...args: unknown[]) => void) =>
      handlers.set(name, handler),
    GetCurrentResourceName: () => "dolu_fivem_mcp_test",
    SetNuiFocus: focus,
    exports: vi.fn(),
    console: { log: vi.fn() },
  });
  return { handlers, focus };
}

describe("disposable fixture focus lifecycle", () => {
  it("never takes focus at startup and changes it only on explicit requests", () => {
    const { handlers, focus } = fixture();
    expect(focus).not.toHaveBeenCalled();
    for (const enabled of [true, false]) {
      const callback = vi.fn();
      handlers.get("__cfx_nui:fixture_focus")!({ enabled }, callback);
      expect(focus).toHaveBeenLastCalledWith(enabled, enabled);
      expect(callback).toHaveBeenCalledWith({ ok: true });
    }
  });

  it("reports invalid focus requests without changing focus", () => {
    const { handlers, focus } = fixture();
    for (const body of [undefined, {}, { enabled: "true" }]) {
      const callback = vi.fn();
      handlers.get("__cfx_nui:fixture_focus")!(body, callback);
      expect(callback).toHaveBeenCalledWith({
        ok: false,
        error: "Expected boolean enabled",
      });
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it("releases focus when its own resource stops, not when another one stops", () => {
    const { handlers, focus } = fixture();
    handlers.get("onClientResourceStop")!("other");
    expect(focus).not.toHaveBeenCalled();
    handlers.get("onClientResourceStop")!("dolu_fivem_mcp_test");
    expect(focus).toHaveBeenCalledExactlyOnceWith(false, false);
  });
});
