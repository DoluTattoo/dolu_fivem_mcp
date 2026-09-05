import { z } from "zod";

const target = {
  selector: z.string().min(1).max(2000).optional(),
  ref: z.string().min(1).max(120).optional(),
};
const hasTarget = (value: { selector?: string; ref?: string }) =>
  Boolean(value.selector) !== Boolean(value.ref);
export const nuiInteractionSchema = z
  .discriminatedUnion("action", [
    z.object({
      ...target,
      action: z.literal("click"),
      mode: z.enum(["dom", "cdp"]).default("dom"),
    }),
    z.object({
      ...target,
      action: z.literal("fill"),
      text: z.string().max(10000),
    }),
    z.object({
      ...target,
      action: z.literal("select"),
      values: z.array(z.string().max(1000)).min(1).max(100),
    }),
    z.object({
      ...target,
      action: z.literal("key"),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space",
        "a",
      ]),
      modifiers: z
        .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
        .max(4)
        .default([]),
    }),
    z.object({ ...target, action: z.literal("hover") }),
    z.object({
      ...target,
      action: z.literal("scroll"),
      deltaX: z.number().finite().min(-10000).max(10000).default(0),
      deltaY: z.number().finite().min(-10000).max(10000).default(0),
    }),
  ])
  .refine(hasTarget, "Specify exactly one selector or snapshot ref");
export type NuiInteraction = z.input<typeof nuiInteractionSchema>;
export const nuiWaitSchema = z
  .object({
    ...target,
    condition: z.enum([
      "visible",
      "hidden",
      "attached",
      "detached",
      "enabled",
      "text",
    ]),
    text: z.string().max(2000).optional(),
    timeoutMs: z.number().int().min(1).max(60000).default(5000),
  })
  .refine(hasTarget, "Specify exactly one selector or snapshot ref")
  .refine(
    (value) => value.condition !== "text" || value.text !== undefined,
    "Text condition requires text",
  );
export type NuiWait = z.input<typeof nuiWaitSchema>;

// Executed only inside the selected document. References are bounded, expire, and
// are invalidated by subtree/attribute mutations (including detach + reattach).
export const DOM_HELPERS = `
var privateSelector = 'input,textarea,select,[contenteditable],script,style,noscript';
var clean = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };
var safeText = function (el) {
  if (el.closest(privateSelector)) return '';
  var walker = document.createTreeWalker(el, 4), out = '', n, count = 0;
  while ((n = walker.nextNode()) && count++ < 10000 && out.length < 12000) {
    if (!n.parentElement.closest(privateSelector)) out += ' ' + n.nodeValue;
  }
  return clean(out).slice(0, 12000);
};
var visible = function (el) {
  if (!el || !el.isConnected || el.closest('[hidden],[inert]')) return false;
  for (var p = el; p; p = p.parentElement) {
    var s = getComputedStyle(p);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
  }
  var r = el.getBoundingClientRect();
  var left = Math.max(0,r.left), top = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
  for (var p=el.parentElement;p;p=p.parentElement) {
    var s=getComputedStyle(p), clip=p.getBoundingClientRect();
    if (['hidden','clip','auto','scroll'].includes(s.overflowX)) { left=Math.max(left,clip.left); right=Math.min(right,clip.right); }
    if (['hidden','clip','auto','scroll'].includes(s.overflowY)) { top=Math.max(top,clip.top); bottom=Math.min(bottom,clip.bottom); }
  }
  return r.width > 0 && r.height > 0 && right > left && bottom > top;
};
var disabled = function (el) { return el.matches(':disabled') || !!el.closest('[aria-disabled="true"],[inert]'); };
var state = globalThis.__doluMcpRefs;
if (!state || state.document !== document) {
  state = { document: document, generation: crypto.randomUUID(), next: 0, refs: new Map(), observer: null };
  state.observer = new MutationObserver(function (records) { invalidate(records); });
  state.observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  globalThis.__doluMcpRefs = state;
}
var invalidate = function (records) {
  if (records.length > 1000) { state.refs.clear(); return; }
  for (var entry of state.refs) {
    var el = entry[1].el;
    if (!el.isConnected || Date.now() > entry[1].expires || records.some(function (r) {
      return el === r.target || el.contains(r.target) ||
        (r.type === 'attributes' && r.target.contains(el)) ||
        Array.from(r.removedNodes || []).some(function (n) { return n === el || n.contains(el); });
    })) state.refs.delete(entry[0]);
  }
};
invalidate(state.observer.takeRecords());
var resolve = function (args, allowMissing) {
  if (args.ref) {
    var saved = state.refs.get(args.ref);
    if (!saved || !saved.el.isConnected) throw new Error('Stale NUI snapshot ref; take a new snapshot');
    return saved.el;
  }
  var matches;
  try { matches = document.querySelectorAll(args.selector); } catch { throw new Error('Invalid CSS selector'); }
  if (matches.length > 1) throw new Error('Ambiguous NUI selector (' + matches.length + ' matches)');
  if (!matches.length && !allowMissing) throw new Error('NUI element not found');
  return matches[0] || null;
};
var point = function (el) {
  if (globalThis.visualViewport && (visualViewport.scale !== 1 || visualViewport.offsetLeft || visualViewport.offsetTop)) throw new Error('NUI input with visual viewport zoom is unsupported');
  if (!visible(el)) throw new Error('NUI element is hidden or outside the viewport');
  if (disabled(el)) throw new Error('NUI element is disabled');
  var r = el.getBoundingClientRect();
  var x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
  var y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
  var hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) throw new Error('NUI element is obscured or clipped');
  return { x: x, y: y, width: innerWidth, height: innerHeight };
};
`;

export const SNAPSHOT =
  DOM_HELPERS +
  `
var elements = [], visited = 0;
var walker = document.createTreeWalker(document.body || document.documentElement, 1), node = walker.currentNode;
while (node && visited++ < 10000 && elements.length < 150) {
  if (node.matches('a,button,input,textarea,select,[role],[tabindex],[contenteditable]')) {
    var ref = undefined;
    for (var entry of state.refs) if (entry[1].el === node) { ref = entry[0]; break; }
    if (!ref) {
      ref = state.generation + ':' + (++state.next);
      if (state.refs.size >= 500) state.refs.delete(state.refs.keys().next().value);
      state.refs.set(ref, { el: node, expires: Date.now() + 120000 });
    }
    var tag = node.tagName.toLowerCase(), type = node.getAttribute('type') || '';
    var role = node.getAttribute('role') || ({ button:'button', a:node.hasAttribute('href')?'link':'', textarea:'textbox', select:node.multiple?'listbox':'combobox' })[tag] ||
      (tag === 'input' ? ({ checkbox:'checkbox', radio:'radio', range:'slider', button:'button', submit:'button' })[type] || 'textbox' : '');
    var name = node.getAttribute('aria-label') || '';
    if (!name && node.getAttribute('aria-labelledby')) name = node.getAttribute('aria-labelledby').split(/\\s+/).slice(0,20).map(function(id) { var label=document.getElementById(id); return label ? safeText(label) : ''; }).join(' ');
    if (!name && node.labels) name = Array.from(node.labels).slice(0,20).map(safeText).join(' ');
    if (!name) name = safeText(node) || node.getAttribute('alt') || node.getAttribute('title') || '';
    var r = node.getBoundingClientRect();
    elements.push({ ref:ref, tag:tag, id:node.id.slice(0,120), role:role.slice(0,80), type:type.slice(0,80), name:clean(name).slice(0,160), text:safeText(node).slice(0,160),
      visible:visible(node), disabled:disabled(node), checked: typeof node.checked === 'boolean' ? node.checked : node.getAttribute('aria-checked'),
      rect:{ x:r.x,y:r.y,width:r.width,height:r.height } });
  }
  node = walker.nextNode();
}
var text = safeText(document.body || document.documentElement);
return { title:clean(document.title).slice(0,200), text:text, elements:elements, truncated:!!node || text.length >= 12000, generation:state.generation, referenceTtlMs:120000 };
`;

export function interactionCode(
  args: z.output<typeof nuiInteractionSchema>,
): string {
  return (
    DOM_HELPERS +
    `
var args = ${JSON.stringify(args)}, el = resolve(args, false), position = point(el);
if (args.action === 'click' && args.mode === 'dom') {
  if (typeof el.click !== 'function') throw new Error('NUI element does not support DOM click');
  el.click(); return { clicked:true, selector:args.selector, ref:args.ref, mode:'dom', trusted:false };
}
if (args.action === 'select') {
  if (el.tagName !== 'SELECT') throw new Error('NUI select requires a select element');
  if (!el.multiple && args.values.length !== 1) throw new Error('Single select requires exactly one value');
  var options = Array.from(el.options);
  for (var value of args.values) {
    var matching = options.filter(function (o) { return o.value === value; });
    if (matching.length !== 1 || matching[0].disabled || matching[0].parentElement.disabled) throw new Error('Select option is missing, ambiguous or disabled');
  }
  for (var option of options) option.selected = args.values.includes(option.value);
  el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
  return { selected:true, trusted:false };
}
if (args.action === 'fill') {
  if (!((el.tagName === 'INPUT' && ['text','search','email','url','tel','password'].includes(el.type)) || el.tagName === 'TEXTAREA') || el.readOnly) throw new Error('Fill requires an editable text input or textarea');
  el.focus({preventScroll:true});
  if (document.activeElement !== el) throw new Error('NUI element could not receive focus');
  el.select();
  if (document.activeElement !== el) throw new Error('NUI focus changed during selection');
} else if (args.action === 'key') {
  el.focus({preventScroll:true});
  if (document.activeElement !== el) throw new Error('NUI element could not receive focus');
}
return point(el);
`
  );
}

export function prepareCode(
  args: z.output<typeof nuiInteractionSchema>,
): string {
  return (
    DOM_HELPERS +
    `
var args=${JSON.stringify(args)}, el=resolve(args,false), position=point(el);
var ref=state.generation+':'+(++state.next);
if(state.refs.size>=500) state.refs.delete(state.refs.keys().next().value);
state.refs.set(ref,{el:el,expires:Date.now()+5000});
return Object.assign(position,{ref:ref});
`
  );
}

export function waitCode(args: z.output<typeof nuiWaitSchema>): string {
  return (
    DOM_HELPERS +
    `
var args = ${JSON.stringify(args)}, el = resolve(args, true), matched = false;
switch(args.condition) {
  case 'attached': matched=!!el; break;
  case 'detached': matched=!el; break;
  case 'visible': matched=!!el && visible(el); break;
  case 'hidden': matched=!el || !visible(el); break;
  case 'enabled': matched=!!el && !disabled(el); break;
  case 'text': matched=!!el && safeText(el).includes(args.text); break;
}
return { matched:matched, condition:args.condition };
`
  );
}

export const FRAME_POINT = `function (position) {
  if (globalThis.visualViewport && (visualViewport.scale !== 1 || visualViewport.offsetLeft || visualViewport.offsetTop)) throw new Error('NUI input with visual viewport zoom is unsupported');
  if (!this.isConnected) throw new Error('NUI frame owner detached');
  for (var p=this;p;p=p.parentElement) {
    var s=getComputedStyle(p);
    if(s.transform !== 'none' || (s.zoom && Number(s.zoom)!==1) || s.display==='none' || s.visibility!=='visible' || Number(s.opacity)===0)
      throw new Error('Hidden or transformed NUI frame is not supported by CDP input');
  }
  if (Math.abs(this.clientWidth-position.width)>1 || Math.abs(this.clientHeight-position.height)>1) throw new Error('NUI iframe viewport scale mismatch');
  var r=this.getBoundingClientRect(), x=r.left+this.clientLeft+position.x, y=r.top+this.clientTop+position.y;
  if(x<0 || y<0 || x>=innerWidth || y>=innerHeight || document.elementFromPoint(x,y)!==this) throw new Error('NUI iframe is obscured or clipped');
  return {x:x,y:y,width:innerWidth,height:innerHeight};
}`;
