import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";

export class ElementFixture {
  nodeType = 1;
  id = "";
  type = "text";
  disabled = false;
  checked = false;
  multiple = false;
  readOnly = false;
  isConnected = true;
  parentElement: ElementFixture | null = null;
  children: ElementFixture[] = [];
  labels: ElementFixture[] = [];
  options: ElementFixture[] = [];
  selected = false;
  attributes = new Map<string, string>();
  textContent = "";
  style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    zoom: "1",
  };
  rect = {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 110,
    bottom: 60,
    width: 100,
    height: 40,
  };
  clicks = 0;
  selections = 0;
  events: string[] = [];
  focus = () => {};
  constructor(public tagName: string) {}
  append(el: ElementFixture) {
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  contains(el: unknown): boolean {
    return el === this || this.children.some((child) => child.contains(el));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  getBoundingClientRect() {
    return this.rect;
  }
  click() {
    this.clicks++;
  }
  select() {
    this.selections++;
  }
  dispatchEvent(event: { type: string }) {
    this.events.push(event.type);
  }
  matches(selector: string): boolean {
    if (selector === ":disabled") return this.disabled;
    return selector.split(",").some((part) => {
      if (part.startsWith("#")) return this.id === part.slice(1);
      const attribute = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(part);
      if (attribute)
        return (
          this.attributes.has(attribute[1]!) &&
          (attribute[2] === undefined ||
            this.attributes.get(attribute[1]!) === attribute[2])
        );
      return part.toUpperCase() === this.tagName;
    });
  }
  closest(selector: string): ElementFixture | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
}

export function domFixture() {
  const body = new ElementFixture("BODY");
  const button = body.append(new ElementFixture("BUTTON"));
  button.id = "button";
  button.textContent = "hello world";
  const input = body.append(new ElementFixture("INPUT"));
  input.id = "input";
  input.type = "password";
  const textarea = body.append(new ElementFixture("TEXTAREA"));
  textarea.id = "textarea";
  textarea.textContent = "secret password";
  const records: unknown[] = [];
  const descendants = (root: ElementFixture): ElementFixture[] =>
    root.children.flatMap((child) => [child, ...descendants(child)]);
  let hit: ElementFixture | null = button;
  const document = {
    body,
    title: "Example",
    activeElement: null as ElementFixture | null,
    elementFromPoint: () => hit,
    querySelectorAll: (selector: string): ElementFixture[] => {
      if (selector === "[") throw new Error("Invalid selector");
      return [body, ...descendants(body)].filter((el) => el.matches(selector));
    },
    getElementById: (id: string) =>
      descendants(body).find((el) => el.id === id),
    createTreeWalker: (root: ElementFixture, type: number) => {
      const els = [root, ...descendants(root)];
      const nodes =
        type === 4
          ? els
              .filter((el) => el.textContent)
              .map((el) => ({
                nodeType: 3,
                parentElement: el,
                nodeValue: el.textContent,
              }))
          : els;
      let index = type === 4 ? -1 : 0;
      return { currentNode: root, nextNode: () => nodes[++index] ?? null };
    },
  };
  for (const el of descendants(body))
    el.focus = () => {
      document.activeElement = el;
    };
  const context = createContext({
    document,
    innerWidth: 800,
    innerHeight: 600,
    crypto: { randomUUID },
    getComputedStyle: (el: ElementFixture) => el.style,
    MutationObserver: class {
      observe() {}
      takeRecords() {
        return records.splice(0);
      }
    },
    Event: class {
      constructor(public type: string) {}
    },
  });
  return {
    body,
    button,
    input,
    textarea,
    document,
    context,
    records,
    hit: (el: ElementFixture | null) => {
      hit = el;
    },
    run: (code: string) => runInContext(code, context) as unknown,
    evaluate: (params: Record<string, unknown>) =>
      runInContext(String(params.expression), context) as unknown,
  };
}
