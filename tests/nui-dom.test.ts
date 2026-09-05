import { describe, expect, it } from "vitest";
import {
  FRAME_POINT,
  SNAPSHOT,
  interactionCode,
  nuiInteractionSchema,
  nuiWaitSchema,
  waitCode,
} from "../src/server/nui-dom";
import { domFixture, ElementFixture } from "./nui-dom-fixture";

describe("NUI document helpers", () => {
  const evaluate = (dom: ReturnType<typeof domFixture>, code: string) =>
    dom.run(`(function(){${code}})()`);
  const snapshot = (dom: ReturnType<typeof domFixture>) =>
    evaluate(dom, SNAPSHOT) as {
      generation: string;
      elements: Array<{
        ref: string;
        name: string;
        role: string;
        visible: boolean;
        checked: boolean;
        rect: unknown;
      }>;
    };
  it("returns stable references, labels, roles, checked and visibility without reading values", () => {
    const dom = domFixture();
    const label = dom.body.append(new ElementFixture("LABEL"));
    label.textContent = "Password";
    dom.input.labels = [label];
    dom.input.type = "checkbox";
    dom.input.attributes.set("type", "checkbox");
    dom.input.checked = true;
    dom.textarea.style.visibility = "hidden";
    Object.defineProperty(dom.input, "value", {
      get() {
        throw new Error("Private input read");
      },
    });
    const first = snapshot(dom),
      second = snapshot(dom);
    expect(first.elements[0]!.ref).toBe(second.elements[0]!.ref);
    expect(first.elements[1]).toMatchObject({
      name: "Password",
      role: "checkbox",
      checked: true,
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });
    expect(first.elements[2]!.visible).toBe(false);
    expect(JSON.stringify(first)).not.toContain("secret password");
  });
  it.each(["attribute", "detach", "reattach", "navigation", "expiry"])(
    "rejects stale refs after %s",
    (reason) => {
      const dom = domFixture();
      const ref = snapshot(dom).elements[0]!.ref;
      if (reason === "attribute")
        dom.records.push({ type: "attributes", target: dom.button });
      if (reason === "detach") dom.button.isConnected = false;
      if (reason === "reattach")
        dom.records.push({
          type: "childList",
          target: dom.body,
          removedNodes: [dom.button],
        });
      if (reason === "navigation")
        dom.run("globalThis.__doluMcpRefs = undefined");
      if (reason === "expiry")
        dom.run(
          `globalThis.__doluMcpRefs.refs.get(${JSON.stringify(ref)}).expires = 0`,
        );
      expect(() =>
        evaluate(
          dom,
          interactionCode(nuiInteractionSchema.parse({ action: "click", ref })),
        ),
      ).toThrow("Stale");
      expect(dom.button.clicks).toBe(0);
    },
  );
  it("caps the registry and snapshot element count", () => {
    const dom = domFixture();
    for (let index = 0; index < 600; index++)
      dom.body.append(new ElementFixture("BUTTON"));
    expect(snapshot(dom).elements).toHaveLength(150);
    expect(dom.run("globalThis.__doluMcpRefs.refs.size")).toBe(150);
  });
  it("selects exact enabled options and does not partially mutate on invalid input", () => {
    const dom = domFixture();
    const select = dom.body.append(new ElementFixture("SELECT"));
    select.id = "select";
    const first = select.append(new ElementFixture("OPTION"));
    const second = select.append(new ElementFixture("OPTION"));
    second.disabled = true;
    Object.defineProperty(first, "value", { value: "one" });
    Object.defineProperty(second, "value", { value: "two" });
    select.options = [first, second];
    dom.hit(select);
    evaluate(
      dom,
      interactionCode(
        nuiInteractionSchema.parse({
          action: "select",
          selector: "#select",
          values: ["one"],
        }),
      ),
    );
    expect(first.selected).toBe(true);
    expect(select.events).toEqual(["input", "change"]);
    expect(() =>
      evaluate(
        dom,
        interactionCode(
          nuiInteractionSchema.parse({
            action: "select",
            selector: "#select",
            values: ["two"],
          }),
        ),
      ),
    ).toThrow("disabled");
    expect(first.selected).toBe(true);
  });
  it("supports all selector wait conditions without revealing private input text", () => {
    const dom = domFixture();
    for (const condition of ["visible", "attached", "enabled"] as const)
      expect(
        evaluate(
          dom,
          waitCode(nuiWaitSchema.parse({ selector: "#button", condition })),
        ),
      ).toMatchObject({ matched: true });
    for (const condition of ["hidden", "detached"] as const)
      expect(
        evaluate(
          dom,
          waitCode(nuiWaitSchema.parse({ selector: "#missing", condition })),
        ),
      ).toMatchObject({ matched: true });
    expect(
      evaluate(
        dom,
        waitCode(
          nuiWaitSchema.parse({
            selector: "#textarea",
            condition: "text",
            text: "secret",
          }),
        ),
      ),
    ).toMatchObject({ matched: false });
    expect(
      evaluate(
        dom,
        waitCode(
          nuiWaitSchema.parse({
            selector: "#button",
            condition: "text",
            text: "hello",
          }),
        ),
      ),
    ).toMatchObject({ matched: true });
  });
  it("validates cross-origin owner offsets, viewport scale, transforms and hit testing without contentDocument", () => {
    const dom = domFixture();
    const iframe = dom.body.append(new ElementFixture("IFRAME"));
    Object.assign(iframe, {
      clientWidth: 400,
      clientHeight: 300,
      clientLeft: 2,
      clientTop: 3,
    });
    dom.context.owner = iframe;
    dom.hit(iframe);
    const code = `(${FRAME_POINT}).call(owner,{x:20,y:30,width:400,height:300})`;
    expect(dom.run(code)).toMatchObject({ x: 32, y: 53 });
    iframe.style.transform = "matrix(1,0,0,1,0,0)";
    expect(() => dom.run(code)).toThrow("transformed");
    iframe.style.transform = "none";
    dom.hit(dom.button);
    expect(() => dom.run(code)).toThrow("obscured");
    dom.hit(iframe);
    expect(() =>
      dom.run(`(${FRAME_POINT}).call(owner,{x:20,y:30,width:200,height:300})`),
    ).toThrow("scale mismatch");
  });
  it("bounds and validates interaction and wait schemas", () => {
    expect(
      nuiInteractionSchema.safeParse({
        action: "key",
        selector: "#x",
        key: "F12",
      }).success,
    ).toBe(false);
    expect(
      nuiInteractionSchema.safeParse({
        action: "click",
        selector: "#x",
        ref: "r",
      }).success,
    ).toBe(false);
    expect(
      nuiInteractionSchema.safeParse({
        action: "fill",
        selector: "#x",
        text: "x".repeat(10001),
      }).success,
    ).toBe(false);
    expect(
      nuiWaitSchema.safeParse({ selector: "#x", condition: "text" }).success,
    ).toBe(false);
    expect(
      nuiWaitSchema.safeParse({
        selector: "#x",
        condition: "visible",
        timeoutMs: 60001,
      }).success,
    ).toBe(false);
  });
});
