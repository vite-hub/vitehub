import { isMotionOff } from "../opt-out.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect, MotionStateAttribute } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring } from "../spring.ts";

/*
 * Select one of many (docs/design/motion.md): one indicator travels from the old item to the new one, stretches toward
 * it, then settles.
 *
 * The indicator is, in this order:
 * 1. An element with `data-motion-indicator` or `data-slot="indicator"` in the new item, such as Nuxt UI's radio dot or
 *    a mark that each item renders while it is selected.
 * 2. The indicator of the group, outside its items: `data-motion-indicator`, or a `data-slot` of `indicator` or that
 *    ends in `-indicator`, such as the indicators of Nuxt UI's and ui-sdk's tabs and segmented controls.
 * 3. Else a copy of the look that the new item has and the old item does not (its background, ring, or border sides).
 *    The copy travels behind the items while the new item hides that look, and the item shows it again on landing.
 *
 * The indicator keeps the place that the page gives it. The effect writes only `translate` and `scale` on top of it
 * while it moves, so a resize or new content keeps it in place with no motion.
 */

// The item roles and the group of each one. A group with no such role, such as a grid of links that marks the hovered
// one with `data-state="active"`, sets `data-motion-select` on its root.
const groups: Record<string, string> = {
  tab: "[role=tablist]",
  radio: "[role=radiogroup]",
  option: "[role=listbox]",
  menuitemradio: "[role=group], [role=menu]",
};
const optIn = "[data-motion-select]";
const anyGroup = `[role=tablist], [role=radiogroup], [role=listbox], [role=group], [role=menu], ${optIn}`;
// Any element in an opt-in group: an item that loses `data-state` no longer matches `[data-state]`.
const byRole = Object.keys(groups).map(role => `[role=${role}]`).join(", ");
const itemSelector = `${byRole}, ${optIn} *`;
const selectionState = ["aria-selected", "aria-checked", "data-state", "data-checked"] as const;
const indicatorItem = `${byRole}, [aria-selected], [aria-checked], [data-checked], ${["active", "inactive", "checked", "unchecked", "on", "off"].map(value => `[data-state=${value}]`).join(", ")}`;
const ownIndicator = "[data-motion-indicator], [data-slot=indicator]";
const groupIndicator = `${ownIndicator}, [data-slot$="-indicator"]`;

// The stretch of the prototype's switch knob: a part of the size per unit of travel speed, up to 55%. The other axis
// gets thinner by a quarter of that part.
const stretchPerSpeed = 0.09;
const stretchMax = 0.55;
const thinning = 0.25;

interface Box { x: number; y: number; width: number; height: number }

/** A group in CSS pixels of the page: its top left corner on screen, and the scale of the transforms around it. */
interface Frame { left: number; top: number; k: number }

interface Flight {
  element: HTMLElement;
  group: HTMLElement;
  /** False while the flight starts, so a spring that jumps does not end it. */
  ready: boolean;
  /** True when a render waits for the springs of this frame. */
  queued: boolean;
  /** Where the element is at rest, relative to the group. */
  rest: Box;
  /** The `translate` that the stylesheet gives the element, and its `transform-origin`, in pixels. */
  translate: [number, number];
  origin: [number, number];
  /** The inner edges of the group on each axis, relative to the group. */
  bounds: [[number, number], [number, number]];
  /** The travel distance on each axis. The stretch reads the speed per unit of travel, as the prototype does. */
  span: [number, number];
  x: Spring;
  y: Spring;
  width: Spring;
  height: Spring;
  /** The item that a copy of its look flies to. */
  copyOf?: HTMLElement;
}

const flights = new WeakMap<HTMLElement, Flight>();
const pending = new Map<HTMLElement, { from?: HTMLElement; to?: HTMLElement }>();
const observedItems = new WeakSet<HTMLElement>();
let frameId = 0;

function isSelected(attribute: MotionStateAttribute, value: string | null): boolean {
  if (attribute === "aria-selected" || attribute === "aria-checked") return value === "true";
  if (attribute === "data-state") return value === "active" || value === "checked" || value === "on";
  if (attribute === "data-checked") return value !== null && value !== "false";
  return false;
}

function groupOf(item: HTMLElement): HTMLElement | null {
  const group = item.parentElement?.closest<HTMLElement>(anyGroup);
  if (!group || group.matches('[role=listbox][aria-multiselectable=true]')) return null;
  const role = item.getAttribute("role");
  const selector = role ? groups[role] : undefined;
  return group.matches(optIn) || (selector && group.matches(selector)) ? group : null;
}

function selected(item: HTMLElement): boolean {
  return selectionState.some(attribute => isSelected(attribute, item.getAttribute(attribute)));
}

function indicatorOwner(group: HTMLElement, indicator: HTMLElement): HTMLElement | undefined {
  for (let node: HTMLElement | null = indicator; node && node !== group; node = node.parentElement) {
    if (observedItems.has(node) || node.matches(indicatorItem)) return node;
  }
  return undefined;
}

function frameOf(group: HTMLElement): Frame {
  const rect = group.getBoundingClientRect();
  return { left: rect.left, top: rect.top, k: group.offsetWidth ? rect.width / group.offsetWidth : 1 };
}

/**
 * The layout box of an element relative to the group, in CSS pixels. The size comes from layout and the center from the
 * screen, so a press that scales an item around its center does not change it.
 */
function boxOf(element: HTMLElement, frame: Frame): Box {
  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth || rect.width / frame.k;
  const height = element.offsetHeight || rect.height / frame.k;
  const x = (rect.left + rect.width / 2 - frame.left) / frame.k - width / 2;
  const y = (rect.top + rect.height / 2 - frame.top) / frame.k - height / 2;
  return { x, y, width, height };
}

/** The indicator of `item`: its own one, or the one of the group that is in no item. */
function indicatorOf(group: HTMLElement, item: HTMLElement): HTMLElement | undefined {
  for (const candidate of item.querySelectorAll<HTMLElement>(ownIndicator)) {
    if (candidate.closest(anyGroup) === group && indicatorOwner(group, candidate) === item) return candidate;
  }
  for (const candidate of group.querySelectorAll<HTMLElement>(groupIndicator)) {
    if (candidate.closest(anyGroup) === group && !indicatorOwner(group, candidate)) return candidate;
  }
  return undefined;
}

// The content box of the group, relative to its border box.
function innerBounds(group: HTMLElement): Flight["bounds"] {
  const style = getComputedStyle(group);
  const left = group.clientLeft + Number.parseFloat(style.paddingLeft);
  const top = group.clientTop + Number.parseFloat(style.paddingTop);
  const right = group.clientLeft + group.clientWidth - Number.parseFloat(style.paddingRight);
  const bottom = group.clientTop + group.clientHeight - Number.parseFloat(style.paddingBottom);
  return [[left, right], [top, bottom]];
}

function pixels(value: string, size: number): number {
  return value.endsWith("%") ? Number.parseFloat(value) / 100 * size : Number.parseFloat(value) || 0;
}

// Where the element is at rest: without what this effect wrote, with the `translate` of its stylesheet.
function measureRest(flight: Flight): void {
  writeMotionStyle(flight.element, { translate: null, scale: null });
  const style = getComputedStyle(flight.element);
  flight.rest = boxOf(flight.element, frameOf(flight.group));
  const [tx = "0", ty = "0"] = style.translate === "none" ? [] : style.translate.split(" ");
  const [ox = "50%", oy = "50%"] = style.transformOrigin.split(" ");
  flight.translate = [pixels(tx, flight.rest.width), pixels(ty, flight.rest.height)];
  flight.origin = [pixels(ox, flight.rest.width), pixels(oy, flight.rest.height)];
}

/** The box of the indicator at rest in `to`, moved and resized to sit the same way in `from`. */
function mapBox(rest: Box, to: Box, from: Box): Box {
  const sx = to.width ? from.width / to.width : 1;
  const sy = to.height ? from.height / to.height : 1;
  return { x: from.x + (rest.x - to.x) * sx, y: from.y + (rest.y - to.y) * sy, width: rest.width * sx, height: rest.height * sy };
}

function moving(flight: Flight | undefined): boolean {
  return !!flight && (flight.x.active || flight.y.active || flight.width.active || flight.height.active);
}

// The four springs move in the same frame, so the box is written once, after the last of them.
function queue(flight: Flight): void {
  if (flight.queued) return;
  flight.queued = true;
  queueMicrotask(() => {
    flight.queued = false;
    render(flight);
  });
}

/**
 * One axis of the box in flight: its start and size, longer by `along` of its size toward where it moves, thinner by a
 * quarter of `across`, and kept inside `bounds` or the place at rest.
 */
function stretch(start: number, size: number, velocity: number, along: number, across: number, bounds: [number, number], restStart: number, restSize: number): [number, number] {
  const extra = along * size;
  const low = Math.min(bounds[0], restStart, start);
  const high = Math.max(bounds[1], restStart + restSize, start + size);
  let from = velocity < 0 ? Math.max(low, start - extra) : start;
  let to = velocity < 0 ? start + size : Math.min(high, start + size + extra);
  const thin = (to - from) * across * thinning / 2;
  from += thin;
  to -= thin;
  return [from, to - from];
}

// One frame: the box of the springs, longer on the side it moves toward, as `translate` and `scale` on top of the place
// at rest. When every spring has settled, the effect clears what it wrote.
function render(flight: Flight): void {
  if (!flight.ready) return;
  const { element, rest, translate, origin, x, y, width, height, span } = flight;
  if (!moving(flight)) {
    writeMotionStyle(element, { translate: null, scale: null });
    land(flight);
    return;
  }
  const fx = Math.min(stretchMax, Math.abs(x.velocity) / span[0] * stretchPerSpeed);
  const fy = Math.min(stretchMax, Math.abs(y.velocity) / span[1] * stretchPerSpeed);
  // The leading edge goes ahead. The trailing edge stays on the spring and catches up. As the prototype's knob stays in
  // its track, the leading edge stops at the inner edge of the group.
  const [left, boxWidth] = stretch(x.value, width.value, x.velocity, fx, fy, flight.bounds[0], rest.x, rest.width);
  const [top, boxHeight] = stretch(y.value, height.value, y.velocity, fy, fx, flight.bounds[1], rest.y, rest.height);
  const scaleX = rest.width ? boxWidth / rest.width : 1;
  const scaleY = rest.height ? boxHeight / rest.height : 1;
  // The layout place is the place at rest less the stylesheet's `translate`. Scale grows around the origin.
  const tx = left - (rest.x - translate[0]) - origin[0] * (1 - scaleX);
  const ty = top - (rest.y - translate[1]) - origin[1] * (1 - scaleY);
  writeMotionStyle(element, { translate: `${tx}px ${ty}px`, scale: `${scaleX} ${scaleY}` });
}

function fly(group: HTMLElement, element: HTMLElement, from: HTMLElement | undefined, to: HTMLElement, copyOf?: HTMLElement): void {
  const previous = flights.get(group);
  const wasMoving = moving(previous);
  if (previous && previous.element !== element) {
    writeMotionStyle(previous.element, { translate: null, scale: null });
    land(previous);
  }
  const flight: Flight = previous ?? {
    element,
    group,
    ready: false,
    rest: { x: 0, y: 0, width: 0, height: 0 },
    translate: [0, 0],
    origin: [0, 0],
    span: [1, 1],
    bounds: [[0, 0], [0, 0]],
    queued: false,
    x: createSpring(0, () => queue(flight), springs.snappy),
    y: createSpring(0, () => queue(flight), springs.snappy),
    width: createSpring(0, () => queue(flight), springs.snappy),
    height: createSpring(0, () => queue(flight), springs.snappy),
  };
  flights.set(group, flight);
  flight.ready = false;
  flight.element = element;
  flight.copyOf = copyOf;
  measureRest(flight);
  flight.bounds = innerBounds(group);
  const { rest } = flight;
  if (!rest.width || !rest.height || (!wasMoving && !from)) {
    flight.ready = true;
    return land(flight);
  }
  if (!wasMoving && from) {
    const frame = frameOf(group);
    const start = mapBox(rest, boxOf(to, frame), boxOf(from, frame));
    flight.x.set(start.x);
    flight.y.set(start.y);
    flight.width.set(start.width);
    flight.height.set(start.height);
  }
  // A flight that moves keeps its speed and turns toward the new item, so a fast second selection never jumps.
  flight.span = [Math.max(Math.abs(rest.x - flight.x.value), rest.width, 1), Math.max(Math.abs(rest.y - flight.y.value), rest.height, 1)];
  flight.x.to(rest.x);
  flight.y.to(rest.y);
  flight.width.to(rest.width);
  flight.height.to(rest.height);
  flight.ready = true;
  render(flight);
}

// The look that a plain item gets when it is selected, which a copy carries. A CSS transition of it on the item would
// show the look twice, so the effect finishes the transition.
const sides = ["top", "right", "bottom", "left"] as const;
const borderParts = ["width", "style", "color"] as const;
const lookProperties = ["background-color", "box-shadow", ...sides.flatMap(side => borderParts.map(part => `border-${side}-${part}`))];

function finishLook(element: HTMLElement): void {
  void getComputedStyle(element).backgroundColor;
  for (const animation of element.getAnimations()) {
    if (animation instanceof CSSTransition && lookProperties.includes(animation.transitionProperty)) animation.finish();
  }
}

const hiddenLook = [
  "[data-motion-select-moving] { isolation: isolate; }",
  "[data-motion-select-hidden~=\"background\"] { background-color: transparent !important; }",
  "[data-motion-select-hidden~=\"shadow\"] { box-shadow: none !important; }",
  ...sides.map(side => `[data-motion-select-hidden~="border-${side}"] { border-${side}-color: transparent !important; }`),
].join("\n");
let sheet: CSSStyleSheet | undefined;

// The rules that hide the look of the item while its copy flies, in the document or the shadow root of the group.
function adoptSheet(node: Node): void {
  const root = node.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(hiddenLook);
  }
  if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

const clear = /^transparent$|^rgba\((?:[^,]+,){3}\s*0(?:\.0+)?\)$|\/\s*0(?:\.0+)?%?\s*\)$/;

/** A copy of the look that `to` has and `from` does not, behind the items, or nothing when they look the same. */
function copyLook(group: HTMLElement, from: HTMLElement, to: HTMLElement): { element: HTMLElement; hidden: string[] } | undefined {
  finishLook(from);
  finishLook(to);
  const was = getComputedStyle(from);
  const now = getComputedStyle(to);
  const hidden: string[] = [];
  const style: Record<string, string> = {
    "position": "absolute",
    "z-index": "-1",
    "box-sizing": "border-box",
    "margin": "0",
    "pointer-events": "none",
    "border-radius": now.borderRadius,
    "background-color": "transparent",
    "box-shadow": "none",
  };
  if (now.backgroundColor !== was.backgroundColor && !clear.test(now.backgroundColor)) {
    style["background-color"] = now.backgroundColor;
    hidden.push("background");
  }
  if (now.boxShadow !== was.boxShadow && now.boxShadow !== "none") {
    style["box-shadow"] = now.boxShadow;
    hidden.push("shadow");
  }
  for (const side of sides) {
    const border = `border-${side}`;
    const width = now.getPropertyValue(`${border}-width`);
    const color = now.getPropertyValue(`${border}-color`);
    style[`${border}-width`] = width;
    style[`${border}-style`] = now.getPropertyValue(`${border}-style`);
    style[`${border}-color`] = "transparent";
    if (Number.parseFloat(width) > 0 && !clear.test(color) && borderParts.some((part) => {
      const property = `${border}-${part}`;
      return now.getPropertyValue(property) !== was.getPropertyValue(property);
    })) {
      style[`${border}-color`] = color;
      hidden.push(border);
    }
  }
  if (!hidden.length) return undefined;
  const element = document.createElement("span");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("data-motion-copy", "");
  for (const [property, value] of Object.entries(style)) element.style.setProperty(property, value);
  adoptSheet(group);
  group.append(element);
  // Its place at rest is the box of the new item, in the box that positions it.
  const parent = element.offsetParent instanceof HTMLElement ? element.offsetParent : document.documentElement;
  const box = boxOf(to, frameOf(parent));
  element.style.left = `${box.x - parent.clientLeft + parent.scrollLeft}px`;
  element.style.top = `${box.y - parent.clientTop + parent.scrollTop}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
  return { element, hidden };
}

// A copy reached its item, or turned to another one: the item shows its own look again, and the copy goes.
function land(flight: Flight): void {
  const item = flight.copyOf;
  if (!item) return;
  flight.copyOf = undefined;
  item.removeAttribute("data-motion-select-hidden");
  finishLook(item);
  flight.element.remove();
  flight.group.removeAttribute("data-motion-select-moving");
}

function cancelFlight(group: HTMLElement): void {
  const flight = flights.get(group);
  if (!flight) return;
  flights.delete(group);
  flight.ready = false;
  for (const spring of [flight.x, flight.y, flight.width, flight.height]) spring.stop();
  writeMotionStyle(flight.element, { translate: null, scale: null });
  land(flight);
}

function move(group: HTMLElement, from: HTMLElement | undefined, to: HTMLElement): void {
  // Under reduced motion the indicator is already in its new place, and a copy is not needed.
  if (prefersReducedMotion() || isMotionOff(to)) return cancelFlight(group);
  const indicator = indicatorOf(group, to);
  if (indicator) return isMotionOff(indicator) ? cancelFlight(group) : fly(group, indicator, from, to);
  // A copy that still flies turns toward the new item. Else a new copy leaves the old item.
  const previous = flights.get(group);
  const source = from ?? (moving(previous) ? previous?.copyOf : undefined);
  if (!source) return;
  const look = copyLook(group, source, to);
  if (!look) return;
  to.setAttribute("data-motion-select-hidden", look.hidden.join(" "));
  finishLook(to);
  fly(group, look.element, from, to, to);
  // Set after `fly`, which lands a copy that still flies and so clears it.
  if (look.element.isConnected) group.setAttribute("data-motion-select-moving", "");
}

// The old and the new item change in one patch of the page, so the effect waits for the next frame to pair them. By
// then a component such as Reka's tabs has also placed its indicator.
function flush(): void {
  frameId = 0;
  const batch = [...pending];
  pending.clear();
  for (const [group, { from, to }] of batch) {
    if (to?.isConnected && groupOf(to) === group && selected(to)) {
      move(group, from?.isConnected && groupOf(from) === group ? from : undefined, to);
    } else if (!group.isConnected || (flights.has(group) && ![...group.querySelectorAll<HTMLElement>(itemSelector)].some(item => selected(item) && groupOf(item) === group))) {
      cancelFlight(group);
    }
  }
}

export const select: MotionEffect = {
  name: "select",
  selector: itemSelector,
  state(element, { attribute, oldValue, value }) {
    const was = isSelected(attribute, oldValue);
    const now = isSelected(attribute, value);
    if (was === now) return;
    const group = groupOf(element);
    if (!group) return;
    observedItems.add(element);
    const entry = pending.get(group) ?? {};
    if (now) entry.to = element;
    else entry.from = element;
    pending.set(group, entry);
    frameId ||= requestAnimationFrame(flush);
  },
};
