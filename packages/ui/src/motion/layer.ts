import { builtInEffects } from "./effects/index.ts";
import { onReducedMotionChange, prefersReducedMotion } from "./reduced-motion.ts";
import { defineMotionEffect, listMotionEffects, motionStateAttributes, onMotionEffectsChange } from "./registry.ts";
import type { MotionContentChange, MotionEffect, MotionPress, MotionStateAttribute } from "./registry.ts";
import { settleSprings } from "./spring.ts";

type MotionRoot = Document | ShadowRoot;

const optOut = "[data-motion=\"none\"]";
const roots = new Map<MotionRoot, { installs: number; observer: MutationObserver }>();
// The presses that are down, by pointer id, or by "key" for Space and Enter.
const presses = new Map<number | "key", Array<{ element: HTMLElement; press: MotionPress; leave?: () => void }>>();
let stopWatching: Array<() => void> = [];
let builtInsDefined = false;

/** True when the element or one of its ancestors, also across shadow roots, has `data-motion="none"`. */
export function isMotionOff(element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    if (node.closest(optOut)) return true;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/** The innermost element on the event path that matches `selector` and is not inside `[data-motion="none"]`. */
function find(path: EventTarget[], selector: string): HTMLElement | undefined {
  let lastOff = -1;
  path.forEach((node, index) => {
    if (node instanceof Element && node.matches(optOut)) lastOff = index;
  });
  const index = path.findIndex(node => node instanceof HTMLElement && node.matches(selector));
  return index === -1 || index <= lastOff ? undefined : path[index] as HTMLElement;
}

function begin(id: number | "key", event: PointerEvent | KeyboardEvent, path: EventTarget[]): void {
  end(id);
  if (prefersReducedMotion()) return;
  const started: Array<{ element: HTMLElement; press: MotionPress; leave?: () => void }> = [];
  for (const effect of listMotionEffects()) {
    if (!effect.press) continue;
    const element = find(path, effect.selector);
    // A key presses only the control that has focus, not a control around it.
    if (!element || (id === "key" && element !== path[0])) continue;
    const press = effect.press(element, event);
    if (!press) continue;
    const item: { element: HTMLElement; press: MotionPress; leave?: () => void } = { element, press };
    // A drag goes on outside the element, as a slider thumb or a resize handle stays behind the pointer at its limit.
    if (id !== "key" && !press.move) {
      item.leave = () => end(id);
      element.addEventListener("pointerleave", item.leave, { once: true });
    }
    started.push(item);
  }
  if (!started.length) return;
  presses.set(id, started);
  if (started.some(item => item.press.move)) document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
}

function end(id: number | "key"): void {
  const items = presses.get(id);
  if (!items) return;
  presses.delete(id);
  for (const { element, press, leave } of items) {
    if (leave) element.removeEventListener("pointerleave", leave);
    press.release();
  }
  if (![...presses.values()].some(list => list.some(item => item.press.move))) {
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  begin(event.pointerId, event, event.composedPath());
}

function onPointerUp(event: PointerEvent): void {
  end(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  for (const { press } of presses.get(event.pointerId) ?? []) press.move?.(event);
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
  const path = event.composedPath();
  // Space scrolls the page on a link, it does not follow it.
  if (event.key === " " && path[0] instanceof Element && path[0].matches("a[href], [role=link]")) return;
  begin("key", event, path);
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === " " || event.key === "Enter") end("key");
}

// The changes of content in one batch of records, by element, for the `content` hook of effects.
function collectContent(records: MutationRecord[], effects: MotionEffect[]): void {
  const watching = effects.filter(effect => effect.content);
  if (!watching.length) return;
  const changes = new Map<HTMLElement | SVGElement, MotionContentChange & { texts: Map<Node, string | null> }>();
  for (const record of records) {
    if (record.type === "attributes") continue;
    const element = record.type === "characterData" ? record.target.parentElement : record.target;
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
    let change = changes.get(element);
    if (!change) {
      change = { added: [], removed: [], oldText: undefined, texts: new Map() };
      changes.set(element, change);
    }
    if (record.type === "characterData") {
      if (!change.texts.has(record.target)) change.texts.set(record.target, record.oldValue);
      continue;
    }
    change.added.push(...record.addedNodes);
    change.removed.push(...record.removedNodes);
  }
  for (const [element, change] of changes) {
    if (!element.isConnected) continue;
    // A node that the batch added and removed again, such as a text that Vue wrote twice, is not part of the change.
    const added = change.added.filter(node => !change.removed.includes(node));
    const removed = change.removed.filter(node => !change.added.includes(node));
    const texts = change.texts;
    // The old text is known when the change replaced every child, as `textContent =` does, or changed its one text node.
    let oldText: string | undefined;
    const children = [...element.childNodes];
    if (removed.length && children.every(node => added.includes(node))) oldText = removed.map(node => node.textContent ?? "").join("");
    else if (texts.size === 1 && children.length === 1 && texts.has(children[0]!)) oldText = texts.get(children[0]!) ?? "";
    for (const effect of watching) {
      if (element.matches(effect.selector) && !isMotionOff(element)) effect.content!(element, { added, removed, oldText });
    }
  }
}

function onMutations(records: MutationRecord[]): void {
  const effects = listMotionEffects();
  collectContent(records, effects);
  for (const record of records) {
    if (record.type === "characterData") continue;
    if (record.type === "attributes") {
      const element = record.target;
      if (!(element instanceof HTMLElement)) continue;
      const attribute = record.attributeName as MotionStateAttribute;
      const value = element.getAttribute(attribute);
      if (value === record.oldValue) continue;
      for (const effect of effects) {
        if (effect.state && element.matches(effect.selector) && !isMotionOff(element)) {
          effect.state(element, { attribute, oldValue: record.oldValue, value });
        }
      }
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !node.isConnected) continue;
      for (const effect of effects) {
        if (!effect.enter) continue;
        const found = [...(node.matches(effect.selector) ? [node] : []), ...node.querySelectorAll<HTMLElement>(effect.selector)];
        for (const element of found) if (!isMotionOff(element)) effect.enter(element);
      }
    }
  }
}

// The observer watches added elements only when an effect has an `enter` or a `content` hook, and text only for `content`.
function observe(root: MotionRoot, observer: MutationObserver): void {
  observer.disconnect();
  const content = listMotionEffects().some(effect => effect.content);
  observer.observe(root, {
    attributes: true,
    attributeFilter: [...motionStateAttributes],
    attributeOldValue: true,
    childList: content || listMotionEffects().some(effect => effect.enter),
    characterData: content,
    characterDataOldValue: content,
    subtree: true,
  });
}

function startDocument(): void {
  const options = { capture: true, passive: true };
  document.addEventListener("pointerdown", onPointerDown, options);
  document.addEventListener("pointerup", onPointerUp, options);
  document.addEventListener("pointercancel", onPointerUp, options);
  document.addEventListener("keydown", onKeyDown, options);
  document.addEventListener("keyup", onKeyUp, options);
  stopWatching = [
    () => {
      document.removeEventListener("pointerdown", onPointerDown, options);
      document.removeEventListener("pointerup", onPointerUp, options);
      document.removeEventListener("pointercancel", onPointerUp, options);
      document.removeEventListener("keydown", onKeyDown, options);
      document.removeEventListener("keyup", onKeyUp, options);
      for (const id of presses.keys()) end(id);
    },
    onReducedMotionChange((reduced) => {
      if (reduced) settleSprings();
    }),
    onMotionEffectsChange(() => {
      for (const [root, { observer }] of roots) observe(root, observer);
    }),
  ];
}

/**
 * Starts the motion layer: press, toggle, select, drag, and appear motion for every element by its role, from
 * `defineMotionEffect` effects. It listens once on the document and reads the composed path, so it also reaches
 * elements in shadow DOM. Pass a shadow root to also watch the state attributes inside it.
 *
 * It is safe to call more than once. Returns a function that stops this install. The layer stops when every install
 * has stopped. On the server it does nothing.
 */
export function installMotion(root?: MotionRoot): () => void {
  if (typeof document === "undefined") return () => {};
  if (!builtInsDefined) {
    builtInsDefined = true;
    for (const effect of builtInEffects) defineMotionEffect(effect);
  }
  const target = root ?? document;
  if (!roots.size) startDocument();
  const entry = roots.get(target);
  if (entry) entry.installs++;
  else {
    const observer = new MutationObserver(onMutations);
    observe(target, observer);
    roots.set(target, { installs: 1, observer });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const current = roots.get(target);
    if (!current || --current.installs > 0) return;
    current.observer.disconnect();
    roots.delete(target);
    if (roots.size) return;
    for (const stop of stopWatching) stop();
    stopWatching = [];
  };
}
