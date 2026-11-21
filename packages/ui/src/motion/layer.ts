import { onReducedMotionChange, prefersReducedMotion } from "./reduced-motion.ts";
import { defineMotionEffect, listMotionEffects, motionStateAttributes, onMotionEffectsChange } from "./registry.ts";
import type { MotionContentChange, MotionEffect, MotionPress, MotionRoot, MotionStateAttribute } from "./registry.ts";
import { settleSprings } from "./spring.ts";

export type { MotionRoot } from "./registry.ts";

const optOut = "[data-motion=\"none\"]";
const roots = new Map<MotionRoot, { installs: number; observer: MutationObserver; watchers: Map<MotionEffect, () => void> }>();
// The presses that are down, by pointer id, or by "key" for Space and Enter.
const presses = new Map<number | "key", Array<{ element: HTMLElement; press: MotionPress; leave?: () => void }>>();
let stopWatching: Array<() => void> = [];
// A page can load more than one copy of this module, such as the app's and the one in the bundle of the page pill. The
// copy that starts a press marks the event with this key, so the press of another copy does not squash it again.
const pressedBy = Symbol.for("vite-hub.motion.pressed");

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

// The selectors of effects that this browser cannot read, such as `:has()` before Firefox 121. Their effects do not apply.
const unreadable = new Set<string>();

/** `element.matches(selector)`, false for a selector that this browser cannot read. */
function matches(element: Element, selector: string): boolean {
  if (unreadable.has(selector)) return false;
  try {
    return element.matches(selector);
  }
  catch {
    unreadable.add(selector);
    return false;
  }
}

/**
 * True when an install covers the element: an installed element contains it, or its root is installed, also through the
 * shadow hosts around it. An app that installs the document covers the shadow roots in it, and the page pill, which
 * installs only its own host and shadow roots, does not move the buttons of the page that it is on.
 */
function covered(element: Element): boolean {
  let node: Element = element;
  for (;;) {
    for (const root of roots.keys()) if (root instanceof Element && root.contains(node)) return true;
    const root = node.getRootNode();
    if ((root instanceof Document || root instanceof ShadowRoot) && roots.has(root)) return true;
    if (!(root instanceof ShadowRoot)) return false;
    node = root.host;
  }
}

/** The innermost element on the event path that matches `selector`, that an install covers, and that is not inside `[data-motion="none"]`. */
function find(path: EventTarget[], selector: string): HTMLElement | undefined {
  let lastOff = -1;
  path.forEach((node, index) => {
    if (node instanceof Element && node.matches(optOut)) lastOff = index;
  });
  const index = path.findIndex(node => node instanceof HTMLElement && matches(node, selector));
  return index === -1 || index <= lastOff || !covered(path[index] as HTMLElement) ? undefined : path[index] as HTMLElement;
}

function begin(id: number | "key", event: PointerEvent | KeyboardEvent, path: EventTarget[]): void {
  end(id);
  if (prefersReducedMotion() || Reflect.get(event, pressedBy)) return;
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
  Reflect.set(event, pressedBy, true);
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
      if (matches(element, effect.selector) && !isMotionOff(element)) effect.content!(element, { added, removed, oldText });
    }
  }
}

function ownsMutation(root: MotionRoot, target: Node): boolean {
  for (let node: Node | null = target; node; node = node.parentNode) {
    if (node === root) return true;
    if (node instanceof Element && roots.has(node)) return false;
  }
  return false;
}

function onMutations(root: MotionRoot, batch: MutationRecord[]): void {
  const records = roots.size === 1 ? batch : batch.filter(record => ownsMutation(root, record.target));
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
        if (effect.state && matches(element, effect.selector) && !isMotionOff(element)) {
          effect.state(element, { attribute, oldValue: record.oldValue, value });
        }
      }
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !node.isConnected) continue;
      for (const effect of effects) {
        if (!effect.enter) continue;
        const self = matches(node, effect.selector);
        if (unreadable.has(effect.selector)) continue;
        const found = [...(self ? [node] : []), ...node.querySelectorAll<HTMLElement>(effect.selector)];
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

function syncWatchers(root: MotionRoot, watchers: Map<MotionEffect, () => void>): void {
  const effects = listMotionEffects();
  for (const [effect, stop] of watchers) {
    if (effects.includes(effect)) continue;
    stop();
    watchers.delete(effect);
  }
  for (const effect of effects) {
    if (effect.watch && !watchers.has(effect)) watchers.set(effect, effect.watch(root));
  }
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
      for (const [root, { observer, watchers }] of roots) {
        observe(root, observer);
        syncWatchers(root, watchers);
      }
    }),
  ];
}

/** What `installMotion` of `@vite-hub/ui/motion/core` runs. */
export interface InstallMotionOptions {
  /**
   * The effects that the install runs, such as `[pressEffect, appearEffect]`. Only these effects go in the bundle.
   * Effects are shared by every install that uses the same copy of the module: an effect that one install adds also
   * runs in the others.
   */
  effects: readonly MotionEffect[];
}

/**
 * Starts the motion layer in `root`, the document, a shadow root, or an element and everything in it, with the effects
 * in `options.effects`. The other built-in effects stay out of the bundle. It listens once on the document and reads the composed path, so a press also reaches
 * the shadow roots inside an installed root. Pass a shadow root to also watch the state attributes inside it: an
 * observer does not see into a shadow root. A surface that installs only its own host and shadow roots, such as the
 * page pill, does not move the elements of the page around it.
 *
 * It is safe to call more than once. Returns a function that stops this install. The layer stops when every install
 * has stopped. On the server it does nothing. `installMotion(root?)` of `@vite-hub/ui/motion` is this function with
 * every built-in effect.
 */
export function installMotion(root: MotionRoot, options: InstallMotionOptions): () => void {
  if (typeof document === "undefined") return () => {};
  // An effect that an app defined with the same name, to replace a built-in one, stays.
  const defined = new Set(listMotionEffects().map(effect => effect.name));
  for (const effect of options.effects) if (!defined.has(effect.name)) defineMotionEffect(effect);
  if (!roots.size) startDocument();
  const entry = roots.get(root);
  if (entry) entry.installs++;
  else {
    const observer = new MutationObserver(records => onMutations(root, records));
    const watchers = new Map<MotionEffect, () => void>();
    observe(root, observer);
    roots.set(root, { installs: 1, observer, watchers });
    syncWatchers(root, watchers);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const current = roots.get(root);
    if (!current || --current.installs > 0) return;
    current.observer.disconnect();
    roots.delete(root);
    for (const stop of current.watchers.values()) stop();
    if (roots.size) return;
    for (const stop of stopWatching) stop();
    stopWatching = [];
  };
}
