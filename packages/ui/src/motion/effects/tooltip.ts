import { isMotionOff } from "../layer.ts";
import { onReducedMotionChange, prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";
import { after, createGhost, pinGhost } from "./ghost.ts";

// The toolbar tooltip of the prototype: it rises from behind its trigger, widens to its label, slides between
// triggers, and sinks back.
const slide = { stiffness: 480, damping: 36 };
const rise = { stiffness: 380, damping: 26 };
const widen = { stiffness: 440, damping: 32 };
/** How wide the tooltip is while it rises, before it widens to its label. */
const narrow = 30;
/** Milliseconds of motion time between the steps. */
const widenAfter = 120;
const labelAfterRise = 70;
const labelAfterSlide = 40;
const sinkAfter = 90;
const goneAfter = 520;
/** Seconds of the label blurs. */
const labelIn = 0.24;
const labelOutOnSlide = 0.15;
const labelOutOnLeave = 0.14;
const crossfade = 0.15;

type Side = "top" | "bottom" | "left" | "right";

/** The springs and the geometry of one tooltip box on the screen: a live tooltip, or the ghost of one that left. */
interface Box {
  element: HTMLElement;
  /** The box without motion: where Floating UI or Reka put it. */
  rest: DOMRect;
  /** The x of `transform-origin` in the box, in pixels. */
  origin: number;
  side: Side;
  /** The edge of the trigger that the tooltip rises from behind, in pixels on the screen. */
  edge: number;
  trigger: DOMRect | undefined;
  /** "clip" reveals a label that is plain text in the box. "scale" scales the box and gives its children the inverse. */
  mode: "clip" | "scale";
  radius: string;
  /** The center of the box on the screen, and its width. */
  x: Spring;
  y: Spring;
  width: Spring;
  /** 0 hides the label, 1 shows it. */
  label: Spring;
  /** The label of the last trigger while it blurs out, and its spring. */
  old?: { element: HTMLElement; spring: Spring };
  /** Opacity of the box, for the reduced motion crossfade. */
  fade: Spring;
  timers: Set<number>;
  /** True while a step sets its springs, so a spring that does not move yet does not clear the box. */
  holding: boolean;
  done?: () => void;
}

interface Tip {
  box?: Box;
  open: boolean;
  /** The element that Floating UI positions: Reka's wrapper, or the tooltip itself. */
  root: HTMLElement;
  parent: Node | null;
  next: Node | null;
  stopWatch?: () => void;
  text: string;
  label: Node[];
  trigger: Element | null;
}

const tips = new WeakMap<HTMLElement, Tip>();
const openTips = new Set<HTMLElement>();
const exitBoxes = new Set<Box>();
/** The ghost of the tooltip that closed last, while a tooltip that opens now can still take its place. */
let handoff: Box | undefined;

function visuallyHidden(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.clipPath === "inset(50%)" || style.clip === "rect(0px, 0px, 0px, 0px)";
}

/** The element with `role=tooltip`: the box itself, or Reka's visually hidden copy of the label in it. */
function roleElement(box: HTMLElement): HTMLElement | null {
  return box.matches("[role=tooltip]") ? box : box.querySelector<HTMLElement>(":scope > [role=tooltip]");
}

/**
 * The box that a person sees. Reka names the trigger with a visually hidden `role=tooltip` element inside the box, so
 * then the box is its parent.
 */
function visualBox(element: HTMLElement): HTMLElement | null {
  if (element.matches("[role=tooltip]")) return visuallyHidden(element) ? element.parentElement : element;
  const inner = element.querySelector<HTMLElement>(":scope > [role=tooltip]");
  return inner && visuallyHidden(inner) ? element : null;
}

function isOpen(box: HTMLElement): boolean {
  const state = box.getAttribute("data-state");
  if (state !== null) return state !== "closed";
  return !box.hidden && !box.hasAttribute("data-closed");
}

function findTrigger(box: HTMLElement): Element | null {
  const id = roleElement(box)?.id;
  if (!id) return null;
  const root = box.getRootNode() as Document | ShadowRoot;
  return root.querySelector(`[aria-describedby~="${CSS.escape(id)}"]`) ?? document.querySelector(`[aria-describedby~="${CSS.escape(id)}"]`);
}

/** The rect of the box without the motion it has now. */
function measureRest(element: HTMLElement): DOMRect {
  const saved = ["translate", "scale", "clip-path", "opacity"].map(name => [name, element.style.getPropertyValue(name)] as const);
  writeMotionStyle(element, { translate: null, scale: null, "clip-path": null });
  const rect = element.getBoundingClientRect();
  for (const [name, value] of saved) if (value) element.style.setProperty(name, value);
  return rect;
}

function sideOf(box: HTMLElement, rest: DOMRect, trigger: DOMRect | undefined): Side {
  const side = box.getAttribute("data-side");
  if (side === "top" || side === "bottom" || side === "left" || side === "right") return side;
  if (!trigger) return "top";
  const dx = trigger.left + trigger.width / 2 - (rest.left + rest.width / 2);
  const dy = trigger.top + trigger.height / 2 - (rest.top + rest.height / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "top" : "bottom";
  return dx > 0 ? "left" : "right";
}

/** The edge of the trigger on the side of the tooltip. Without a trigger, 8px past the box. */
function edgeOf(side: Side, rest: DOMRect, trigger: DOMRect | undefined): number {
  if (side === "top") return trigger?.top ?? rest.bottom + 8;
  if (side === "bottom") return trigger?.bottom ?? rest.top - 8;
  if (side === "left") return trigger?.left ?? rest.right + 8;
  return trigger?.right ?? rest.left - 8;
}

const vertical = (side: Side) => side === "top" || side === "bottom";

/** The center of the box when it sits fully behind its trigger. */
function hiddenCenter(box: Box): number {
  const { rest, side, edge } = box;
  if (side === "top") return edge + rest.height / 2;
  if (side === "bottom") return edge - rest.height / 2;
  if (side === "left") return edge + rest.width / 2;
  return edge - rest.width / 2;
}

/** The label: the children of the box that a person sees, without Reka's hidden copy and the old label. */
function labelElements(box: Box): HTMLElement[] {
  return [...box.element.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && child !== box.old?.element && !child.matches("[role=tooltip]") && !visuallyHidden(child));
}

/** The text of the label, without Reka's hidden copy and the old label. */
function labelText(box: Box): string {
  return [...box.element.childNodes]
    .filter(node => node.nodeType === Node.TEXT_NODE || (node instanceof Element && node !== box.old?.element && !node.matches("[role=tooltip]") && !visuallyHidden(node)))
    .map(node => node.textContent ?? "")
    .join("");
}

function hasTextOfItsOwn(element: HTMLElement): boolean {
  return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

/** Writes one frame of a box: where it is, how wide, how much of it is behind the trigger, and its label. */
function draw(box: Box): void {
  const { element, rest, side, edge, origin } = box;
  const width = Math.max(1, box.width.value);
  const reveal = box.mode === "clip" && width < rest.width;
  const scale = reveal ? 1 : width / rest.width;
  // Scaling about the origin moves the left edge by origin * (1 - scale), so the translate takes that back.
  const left = box.x.value - width / 2;
  const tx = reveal ? box.x.value - (rest.left + rest.width / 2) : left - rest.left - origin * (1 - scale);
  const ty = box.y.value - (rest.top + rest.height / 2);
  // The part of the box past the edge of the trigger is behind the trigger, in pixels of the box.
  const insets = [-40, -40, -40, -40];
  if (side === "top") insets[2] = box.y.value + rest.height / 2 - edge;
  if (side === "bottom") insets[0] = edge - (box.y.value - rest.height / 2);
  if (side === "left") insets[1] = (box.x.value + width / 2 - edge) / scale;
  if (side === "right") insets[3] = (edge - (box.x.value - width / 2)) / scale;
  const behind = insets.some(inset => inset > 0);
  let clip: string | null = null;
  if (reveal) {
    const hidden = (rest.width - width) / 2;
    clip = `inset(${[Math.max(0, insets[0]!), hidden + Math.max(0, insets[1]!), Math.max(0, insets[2]!), hidden + Math.max(0, insets[3]!)].map(px).join(" ")} round ${box.radius})`;
  }
  else if (behind) clip = `inset(${insets.map(px).join(" ")})`;
  writeMotionStyle(element, {
    "translate": Math.abs(tx) > 0.01 || Math.abs(ty) > 0.01 || box.old ? `${px(tx)} ${px(ty)}` : null,
    "scale": Math.abs(scale - 1) > 0.001 ? `${scale} 1` : null,
    "clip-path": clip,
    "opacity": box.fade.active || box.fade.value < 1 ? String(box.fade.value) : null,
  });
  const inverse = Math.abs(scale - 1) > 0.001 ? `${1 / scale} 1` : null;
  const label = box.label.value;
  for (const child of labelElements(box)) {
    writeMotionStyle(child, {
      scale: inverse,
      opacity: label < 1 ? String(label) : null,
      filter: label < 1 ? `blur(${px((1 - label) * 6)})` : null,
    });
  }
  if (box.old) {
    const value = box.old.spring.value;
    writeMotionStyle(box.old.element, { scale: inverse, opacity: String(value), filter: `blur(${px((1 - value) * 5)})` });
  }
}

/** Clears what the box wrote when nothing on it moves and no step waits. */
function settle(box: Box): void {
  if (box.holding || box.timers.size || [box.x, box.y, box.width, box.label, box.fade, box.old?.spring].some(spring => spring?.active)) return;
  box.old?.element.remove();
  box.old = undefined;
  writeMotionStyle(box.element, { "translate": null, "scale": null, "clip-path": null, "opacity": null });
  for (const child of labelElements(box)) writeMotionStyle(child, { scale: null, opacity: null, filter: null });
  box.done?.();
}

function createBox(element: HTMLElement, rest: DOMRect, trigger: DOMRect | undefined): Box {
  const style = getComputedStyle(element);
  const side = sideOf(element, rest, trigger);
  const box = {
    element,
    rest,
    origin: Number.parseFloat(style.transformOrigin) || rest.width / 2,
    side,
    edge: edgeOf(side, rest, trigger),
    trigger,
    mode: hasTextOfItsOwn(element) ? "clip" : "scale",
    radius: style.borderRadius || "0px",
    timers: new Set<number>(),
    holding: true,
  } as Box;
  const frame = () => {
    draw(box);
    settle(box);
  };
  box.x = createSpring(rest.left + rest.width / 2, frame, slide);
  box.y = createSpring(rest.top + rest.height / 2, frame, slide);
  box.width = createSpring(rest.width, frame, widen);
  box.label = createSpring(1, frame);
  box.fade = createSpring(1, frame);
  return box;
}

function later(box: Box, ms: number, step: () => void): void {
  const timer = after(ms, () => {
    box.timers.delete(timer);
    step();
    settle(box);
  });
  box.timers.add(timer);
}

function stopBox(box: Box): void {
  for (const timer of box.timers) clearTimeout(timer);
  box.timers.clear();
  for (const spring of [box.x, box.y, box.width, box.label, box.fade, box.old?.spring]) spring?.stop();
}

function removeGhost(box: Box): void {
  stopBox(box);
  exitBoxes.delete(box);
  if (handoff === box) handoff = undefined;
  box.element.closest("[data-motion=none]")?.remove();
}

function reduceTooltips(reduced: boolean): void {
  if (!reduced) return;
  for (const ghost of exitBoxes) removeGhost(ghost);
  for (const element of openTips) {
    const box = tips.get(element)?.box;
    if (!box) continue;
    stopBox(box);
    box.holding = true;
    box.x.set(box.rest.left + box.rest.width / 2);
    box.y.set(box.rest.top + box.rest.height / 2);
    box.width.set(box.rest.width);
    box.label.set(1);
    box.fade.set(1);
    box.holding = false;
    settle(box);
  }
}

/**
 * True when the trigger of `to` sits next to the trigger of `from`, as in one toolbar: on the same side, in the same
 * row for a tooltip above or below, or in the same column for one beside. A tooltip in another place rises on its own.
 */
function nextTo(from: Box, to: Box): boolean {
  const a = from.trigger;
  const b = to.trigger;
  if (!a || !b || from.side !== to.side) return false;
  return vertical(to.side) ? a.top < b.bottom && b.top < a.bottom : a.left < b.right && b.left < a.right;
}

/** Moves the springs of `box` along the axis of its side: up and down for a tooltip above or below its trigger. */
function along(box: Box): Spring {
  return vertical(box.side) ? box.y : box.x;
}

/** Shows the label of another trigger in the box while it blurs out, from `from` (1 is sharp). */
function blurOutOld(box: Box, nodes: Node[], from: number): void {
  if (!nodes.length) return;
  const element = document.createElement("span");
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", gap: "inherit", pointerEvents: "none", whiteSpace: "nowrap" });
  element.append(...nodes);
  box.element.append(element);
  const spring = createSpring(from, () => {
    draw(box);
    settle(box);
  });
  box.old = { element, spring };
  spring.to(0, { tween: labelOutOnSlide });
}

/** The label nodes of a box, copied, to show in another box while they blur out. */
function copyLabel(box: Box): Node[] {
  if (box.mode === "clip") return [...box.element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.cloneNode());
  return labelElements(box).map((child) => {
    const copy = child.cloneNode(true) as HTMLElement;
    copy.style.removeProperty("scale");
    copy.style.removeProperty("opacity");
    copy.style.removeProperty("filter");
    return copy;
  });
}

/** Starts the motion of a tooltip that opened, once Floating UI has placed it. */
function start(element: HTMLElement, tip: Tip): void {
  const triggerRect = tip.trigger?.getBoundingClientRect();
  const rest = measureRest(element);
  const box = createBox(element, rest, triggerRect);
  tip.box = box;
  tip.text = labelText(box);
  tip.label = copyLabel(box);
  writeMotionStyle(element, { opacity: null });
  const from = handoff && nextTo(handoff, box) ? handoff : undefined;
  if (from) handoff = undefined;
  if (prefersReducedMotion()) {
    if (from) leaveGhost(from, true);
    box.fade.set(0);
    box.holding = false;
    box.fade.to(1, { tween: crossfade });
    return;
  }
  if (from) {
    // The tooltip of the last trigger is still out: this one takes its place, size, and speed, and slides over.
    const old = copyLabel(from);
    const values = { x: [from.x.value, from.x.velocity], y: [from.y.value, from.y.velocity], width: [from.width.value, from.width.velocity] } as const;
    const label = from.old ? 0 : from.label.value;
    removeGhost(from);
    box.x.set(values.x[0]);
    box.y.set(values.y[0]);
    box.width.set(values.width[0]);
    box.label.set(0);
    blurOutOld(box, old, label);
    box.x.to(rest.left + rest.width / 2, { preset: slide, velocity: values.x[1] });
    box.y.to(rest.top + rest.height / 2, { preset: slide, velocity: values.y[1] });
    box.width.to(rest.width, { preset: widen, velocity: values.width[1] });
    later(box, labelAfterSlide, () => box.label.to(1, { tween: labelIn }));
    box.holding = false;
    draw(box);
    return;
  }
  // It rises from behind its trigger, narrow and without its label, then widens to its label.
  along(box).set(hiddenCenter(box));
  box.width.set(Math.min(narrow, rest.width));
  box.label.set(0);
  draw(box);
  along(box).to(vertical(box.side) ? rest.top + rest.height / 2 : rest.left + rest.width / 2, { preset: rise });
  later(box, widenAfter, () => {
    box.width.to(rest.width, { preset: widen });
    later(box, labelAfterRise, () => box.label.to(1, { tween: labelIn }));
  });
  box.holding = false;
}

/** Plays the exit of a ghost: the label blurs out, the box narrows, then it sinks behind its trigger. */
function leaveGhost(box: Box, reduced: boolean): void {
  exitBoxes.add(box);
  box.holding = false;
  if (reduced) {
    box.done = () => removeGhost(box);
    box.fade.to(0, { tween: crossfade });
    return;
  }
  handoff = box;
  if (box.old) box.old.spring.to(0, { tween: labelOutOnLeave });
  box.label.to(0, { tween: labelOutOnLeave });
  box.width.to(Math.min(narrow, box.rest.width), { preset: widen });
  later(box, sinkAfter, () => {
    if (handoff === box) handoff = undefined;
    along(box).to(hiddenCenter(box), { preset: rise });
  });
  later(box, goneAfter, () => removeGhost(box));
}

/** The tooltip closed or left the page: its ghost plays the exit where it was. */
function leave(element: HTMLElement, tip: Tip): void {
  if (!tip.open) return;
  tip.open = false;
  openTips.delete(element);
  tip.stopWatch?.();
  tip.stopWatch = undefined;
  if (!openTips.size) stopWatchingMoves();
  const box = tip.box;
  tip.box = undefined;
  writeMotionStyle(element, { opacity: null });
  if (!box) return;
  // Copy the box as it is now, with its motion, before the live one clears it.
  const parent = tip.root.parentNode ?? tip.parent;
  const ghostRoot = parent ? createGhost(tip.root, parent, tip.root.isConnected ? tip.root.nextSibling : tip.next) : undefined;
  const now = { x: box.x, y: box.y, width: box.width, label: box.label, fade: box.fade };
  const values = Object.fromEntries(Object.entries(now).map(([name, spring]) => [name, [spring.value, spring.velocity]])) as Record<keyof typeof now, [number, number]>;
  const oldLabel = box.old?.spring.value;
  stopBox(box);
  box.old?.element.remove();
  writeMotionStyle(element, { "translate": null, "scale": null, "clip-path": null, "opacity": null });
  for (const child of labelElements(box)) writeMotionStyle(child, { scale: null, opacity: null, filter: null });
  if (!ghostRoot) return;
  const path = pathTo(tip.root, element);
  const ghostElement = path.reduce<Element | undefined>((node, index) => node?.children[index], ghostRoot);
  if (!(ghostElement instanceof HTMLElement)) {
    ghostRoot.remove();
    return;
  }
  if (element.hasAttribute("popover")) {
    writeMotionStyle(ghostElement, { scale: null });
    pinGhost(ghostElement, box.rest);
  }
  const ghost = createBox(ghostElement, box.rest, undefined);
  Object.assign(ghost, { side: box.side, edge: box.edge, trigger: box.trigger, mode: box.mode, origin: box.origin, radius: box.radius });
  const old = ghostElement.querySelector<HTMLElement>(":scope > [aria-hidden=true][style*=absolute]");
  if (oldLabel !== undefined && old) ghost.old = { element: old, spring: createSpring(oldLabel, () => draw(ghost)) };
  for (const name of ["x", "y", "width", "label", "fade"] as const) ghost[name].set(values[name][0]);
  draw(ghost);
  // The ghost keeps the speed that the box had, so a tooltip that leaves while it still moves does not stop first.
  for (const name of ["x", "y", "width"] as const) {
    if (values[name][1]) ghost[name].to(values[name][0], { velocity: values[name][1] });
  }
  leaveGhost(ghost, prefersReducedMotion());
}

/** The child indexes from `root` down to `element`. */
function pathTo(root: Element, element: Element): number[] {
  const path: number[] = [];
  for (let node: Element = element; node !== root && node.parentElement; node = node.parentElement) {
    path.unshift([...node.parentElement.children].indexOf(node));
  }
  return path;
}

/** Waits until Floating UI has placed the box: Reka keeps its wrapper far above the page until then. */
function whenPlaced(element: HTMLElement, tip: Tip, callback: () => void, frames = 20): void {
  requestAnimationFrame(() => {
    if (!tip.open || !element.isConnected) return;
    const wrapper = element.closest<HTMLElement>("[data-reka-popper-content-wrapper]");
    if (frames > 0 && wrapper?.style.transform.includes("-200%")) return whenPlaced(element, tip, callback, frames - 1);
    callback();
  });
}

function open(element: HTMLElement): void {
  let tip = tips.get(element);
  if (tip?.open) return;
  const trigger = findTrigger(element);
  // A tooltip sits in a portal, away from its trigger, so a trigger inside `data-motion="none"` turns its tooltip off too.
  if (trigger && isMotionOff(trigger)) return;
  const root = element.closest<HTMLElement>("[data-reka-popper-content-wrapper]") ?? element;
  tip = { open: true, root, parent: root.parentNode, next: root.nextSibling, text: "", label: [], trigger };
  tips.set(element, tip);
  openTips.add(element);
  watchMoves();
  // Hidden until it is placed, so its first frame is already behind its trigger.
  writeMotionStyle(element, { opacity: "0" });
  // Reka removes a closed tooltip without changing its state first, so the effect also watches its parent.
  if (root.parentNode) {
    const current = tip;
    const observer = new MutationObserver(() => {
      if (!root.isConnected) leave(element, current);
    });
    observer.observe(root.parentNode, { childList: true });
    tip.stopWatch = () => observer.disconnect();
  }
  const current = tip;
  whenPlaced(element, tip, () => start(element, current));
}

// A tooltip that one component shows for several triggers, such as ui-sdk's tooltip with a controller, stays open and
// moves to the next trigger. After each pointer or focus move, the effect checks whether an open tooltip moved.
let checking = 0;
function checkMoves(): void {
  checking = 0;
  for (const element of openTips) {
    const tip = tips.get(element);
    const box = tip?.box;
    if (!tip || !box) continue;
    const rest = measureRest(element);
    const text = labelText(box);
    const moved = Math.abs(rest.left - box.rest.left) > 1 || Math.abs(rest.top - box.rest.top) > 1 || Math.abs(rest.width - box.rest.width) > 1;
    if (!moved && text === tip.text) continue;
    const old = text === tip.text ? [] : tip.label;
    tip.trigger = findTrigger(element) ?? tip.trigger;
    const triggerRect = tip.trigger?.getBoundingClientRect();
    tip.text = text;
    tip.label = copyLabel(box);
    box.rest = rest;
    box.side = sideOf(element, rest, triggerRect);
    box.edge = edgeOf(box.side, rest, triggerRect);
    if (prefersReducedMotion()) {
      box.x.set(rest.left + rest.width / 2);
      box.y.set(rest.top + rest.height / 2);
      box.width.set(rest.width);
      continue;
    }
    box.x.to(rest.left + rest.width / 2, { preset: slide });
    box.y.to(rest.top + rest.height / 2, { preset: slide });
    box.width.to(rest.width, { preset: widen });
    if (old.length) {
      box.old?.spring.stop();
      box.old?.element.remove();
      blurOutOld(box, old, box.label.value);
      box.label.set(0);
      later(box, labelAfterSlide, () => box.label.to(1, { tween: labelIn }));
    }
  }
}
function onMove(): void {
  if (!checking) checking = requestAnimationFrame(checkMoves);
}
let watching = false;
let stopWatchingReduction: (() => void) | undefined;
function watchMoves(): void {
  stopWatchingReduction ??= onReducedMotionChange(reduceTooltips);
  if (watching) return;
  watching = true;
  document.addEventListener("pointerover", onMove, { capture: true, passive: true });
  document.addEventListener("focusin", onMove, { capture: true, passive: true });
}
function stopWatchingMoves(): void {
  watching = false;
  document.removeEventListener("pointerover", onMove, { capture: true });
  document.removeEventListener("focusin", onMove, { capture: true });
}

/**
 * Something appears next to its trigger: a tooltip rises from behind its trigger, narrow and without its label,
 * widens to fit, and blurs its label in. When the next trigger opens its tooltip while this one leaves, the new one
 * takes the place, size, and speed of the old one and slides over. A tooltip that closes narrows and sinks back behind
 * its trigger. Under reduced motion it crossfades in 150ms.
 *
 * Floating UI or Reka still places the tooltip. The effect only adds `translate`, `scale`, `clip-path`, `opacity`, and
 * `filter` to that.
 */
export const tooltip: MotionEffect = {
  name: "tooltip",
  // Reka puts `role=tooltip` on a visually hidden copy of the label inside the box, so the box is its parent.
  selector: "[role=tooltip], :has(> [role=tooltip])",
  enter(element) {
    if (visualBox(element) !== element || !isOpen(element)) return;
    open(element);
  },
  state(element) {
    if (visualBox(element) !== element) return;
    const tip = tips.get(element);
    if (isOpen(element)) open(element);
    else if (tip) leave(element, tip);
  },
};
