import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

// The slider of the prototype. The thumb follows its value with a spring, a tail of ink trails it with its speed and
// stays inside the track, and the thumb grows by 12% while it is held. The filled range ends under the thumb. The
// stretch with speed is the switch knob's of the prototype, by track lengths per second, as its slider thumb stays round.
const followSpring = { stiffness: 520, damping: 38 };
const trail = { stiffness: 260, damping: 30 };
const heldScale = 1.12;
/** The longest tail, in pixels. */
const tailMax = 150;
/** Pixels of tail for each pixel per second of thumb speed. */
const tailPerSpeed = 0.13;
/** The tail turns when the thumb moves faster than this many track lengths per second. */
const turnSpeed = 0.05;
/** The tail tapers from 95% of the thumb radius to nothing over this many points. */
const tailPoints = 28;
const stretchPerSpeed = 0.09;
const stretchMax = 0.55;

const svgNamespace = "http://www.w3.org/2000/svg";
/** The value of a slider: `[role=slider]` (Nuxt UI, Reka, plain), or the range input inside a ui-sdk and kit thumb. */
const valueSelector = "[role=slider], input[type=range]";
/** The filled part of the track: Nuxt UI and Reka, ui-sdk and kit. */
const rangeSelector = "[data-slot=range], [data-slot=slider-indicator]";

type Axis = "x" | "y";

interface ThumbMotion {
  thumb: HTMLElement;
  track: HTMLElement;
  range: HTMLElement | null;
  axis: Axis;
  /** The center of the thumb in the layout, along the axis, from the start of the track. */
  layout: number;
  length: number;
  /** Client pixels for each CSS pixel of the track. */
  zoom: number;
  /** The direction of the last fast move. The tail points the other way. */
  direction: 1 | -1;
  held: boolean;
  /** The center of the thumb that people see, from the start of the track. */
  position: Spring;
  /** The length of the tail in pixels. */
  tail: Spring;
  /** The inline `translate` of the component, such as ui-sdk's `0 -50%`, which the effect adds to. */
  ownTranslate: { raw: string; x: string; y: string };
  lane?: SVGPathElement;
}

const motions = new WeakMap<HTMLElement, ThumbMotion>();

/**
 * The element that people see as the thumb. A ui-sdk thumb holds a transparent range input that fills it, so its
 * thumb is the parent. A range input of its own draws its thumb in a pseudo-element, which no effect can move.
 */
function thumbOf(element: HTMLElement): HTMLElement | undefined {
  if (!(element instanceof HTMLInputElement)) return element;
  const parent = element.parentElement;
  if (!parent || getComputedStyle(element).position !== "absolute") return undefined;
  return parent;
}

function axisOf(value: HTMLElement): Axis {
  return value.getAttribute("aria-orientation") === "vertical" || value.closest("[data-orientation=vertical]") ? "y" : "x";
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The box of an element in CSS pixels of the track, where the effect draws. A page with CSS `zoom` or a scaled parent
 * makes client pixels larger, so the client box is divided by the scale of the track.
 */
function rectOf(element: Element, motion: { zoom: number }): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left: left / motion.zoom, top: top / motion.zoom, width: width / motion.zoom, height: height / motion.zoom };
}

function zoomOf(track: HTMLElement): number {
  return track.offsetWidth ? track.getBoundingClientRect().width / track.offsetWidth || 1 : 1;
}

function along(rect: Rect, axis: Axis): { start: number; size: number } {
  return axis === "x" ? { start: rect.left, size: rect.width } : { start: rect.top, size: rect.height };
}

/** The center of the thumb in the layout, without the `translate` and `scale` that this effect writes. */
function measure(motion: ThumbMotion): number {
  const { thumb, track, axis } = motion;
  motion.zoom = zoomOf(track);
  const shown = along(rectOf(thumb, motion), axis);
  const trackBox = along(rectOf(track, motion), axis);
  motion.length = trackBox.size;
  return shown.start + shown.size / 2 - trackBox.start - (motions.get(thumb) === motion ? motion.position.value - motion.layout : 0);
}

function number(value: string | null): number {
  return Number.parseFloat(value ?? "");
}

/**
 * Where the thumb was before its first change, from the old and the new value. The thumb moves `travel` pixels from
 * its minimum to its maximum: the track less the thumb (Reka's default), or the full track (ui-sdk). The minimum is
 * at the start of the track, or at the end for a vertical or right-to-left slider.
 */
function previousCenter(motion: ThumbMotion, value: HTMLElement, from: number, to: number): number | undefined {
  const min = number(value.getAttribute("aria-valuemin") ?? value.getAttribute("min"));
  const max = number(value.getAttribute("aria-valuemax") ?? value.getAttribute("max"));
  const minimum = Number.isFinite(min) ? min : 0;
  const maximum = Number.isFinite(max) ? max : 100;
  if (!(maximum > minimum) || !Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const size = along(rectOf(motion.thumb, motion), motion.axis).size;
  const fraction = (to - minimum) / (maximum - minimum);
  let best: { error: number; travel: number; sign: number } | undefined;
  for (const travel of [motion.length - size, motion.length]) {
    for (const sign of [1, -1]) {
      const predicted = sign > 0 ? (motion.length - travel) / 2 + fraction * travel : motion.length - (motion.length - travel) / 2 - fraction * travel;
      const error = Math.abs(predicted - motion.layout);
      if (!best || error < best.error) best = { error, travel, sign };
    }
  }
  if (!best || best.error > 3) return undefined;
  return motion.layout - best.sign * ((to - from) / (maximum - minimum)) * best.travel;
}

function split(translate: string): { raw: string; x: string; y: string } {
  const [x = "0px", y = "0px"] = translate.split(" ").filter(Boolean);
  return { raw: translate, x, y };
}

function start(thumb: HTMLElement, value: HTMLElement): ThumbMotion | undefined {
  const track = thumb.parentElement;
  if (!track) return undefined;
  const axis = axisOf(value);
  const motion: ThumbMotion = {
    thumb,
    track,
    range: track.querySelector<HTMLElement>(rangeSelector),
    axis,
    layout: 0,
    length: 0,
    zoom: 1,
    direction: 1,
    held: false,
    position: createSpring(0, (_value, velocity) => {
      if (Math.abs(velocity) > turnSpeed * motion.length) motion.direction = velocity > 0 ? 1 : -1;
      motion.tail.to(Math.min(tailMax, Math.abs(velocity) * tailPerSpeed));
      draw(motion);
    }, followSpring),
    tail: createSpring(0, () => draw(motion), trail),
    ownTranslate: split(thumb.style.translate),
  };
  motion.layout = measure(motion);
  motion.position.set(motion.layout);
  motions.set(thumb, motion);
  return motion;
}

function finish(motion: ThumbMotion): void {
  motions.delete(motion.thumb);
  motion.position.stop();
  motion.tail.stop();
  writeMotionStyle(motion.thumb, { translate: motion.ownTranslate.raw || null, scale: null });
  if (motion.range) writeMotionStyle(motion.range, { translate: null, scale: null });
  motion.lane?.ownerSVGElement?.remove();
}

/** Stretches the filled range so that it ends under the thumb that people see, `shift` pixels from its layout. */
function drawRange(motion: ThumbMotion, shift: number): void {
  const { range, axis, track } = motion;
  if (!range) return;
  if (Math.abs(shift) < 0.01) {
    writeMotionStyle(range, { translate: null, scale: null });
    return;
  }
  const size = axis === "x" ? range.offsetWidth : range.offsetHeight;
  if (size < 1) return;
  const rangeBox = along(rectOf(range, motion), axis);
  const trackStart = along(rectOf(track, motion), axis).start;
  // The range's layout box, without what this effect wrote on it last frame.
  const middle = rangeBox.start + rangeBox.size / 2;
  const start = middle - size / 2 - (axis === "x" ? Number.parseFloat(range.style.translate) || 0 : Number.parseFloat(split(range.style.translate).y) || 0);
  const end = start + size;
  const center = trackStart + motion.layout;
  // The end of the range that is nearer to the thumb moves with it.
  const moveEnd = Math.abs(center - end) <= Math.abs(center - start);
  const from = moveEnd ? start : start + shift;
  const to = Math.max(from + 0.01, moveEnd ? end + shift : end);
  const scale = (to - from) / size;
  const move = (from + to) / 2 - (start + end) / 2;
  writeMotionStyle(range, {
    translate: axis === "x" ? `${move}px 0px` : `0px ${move}px`,
    scale: axis === "x" ? `${scale} 1` : `1 ${scale}`,
  });
}

/** The tail of the prototype: from the thumb back along the track, tapering, cut where the track ends. */
function drawTail(motion: ThumbMotion): void {
  const { thumb, track, axis, direction, length, range } = motion;
  const tail = Math.min(tailMax, motion.tail.value);
  if (tail <= 2) {
    motion.lane?.setAttribute("d", "");
    return;
  }
  if (!motion.lane) {
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.dataset.motion = "tail";
    svg.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;margin:0";
    const path = document.createElementNS(svgNamespace, "path");
    path.style.fill = getComputedStyle(range ?? thumb).backgroundColor;
    svg.append(path);
    motion.lane = path;
  }
  const svg = motion.lane.ownerSVGElement!;
  if (!svg.isConnected) thumb.before(svg);
  const origin = rectOf(svg, motion);
  const trackRect = rectOf(track, motion);
  const thumbRect = rectOf(thumb, motion);
  // The thumb's radius across the track, without the scale of a held thumb.
  const radius = (axis === "x" ? thumbRect.height : thumbRect.width) / 2 / (motion.held ? heldScale : 1);
  const cross = axis === "x" ? thumbRect.top + thumbRect.height / 2 - origin.top : thumbRect.left + thumbRect.width / 2 - origin.left;
  const trackStart = (axis === "x" ? trackRect.left - origin.left : trackRect.top - origin.top);
  const at = Math.max(0, Math.min(length, motion.position.value));
  const reach = Math.min(tail, direction > 0 ? at : length - at);
  // Behind a thumb that moves toward the end of the range, the tail keeps the thickness of the range, as the
  // prototype's keeps the thickness of its ink.
  const thinnest = direction > 0 && range ? (axis === "x" ? range.offsetHeight : range.offsetWidth) / 2 : 0;
  const one: string[] = [];
  const other: string[] = [];
  for (let index = 0; index <= tailPoints; index++) {
    const progress = index / tailPoints;
    const point = (trackStart + at - direction * reach * progress).toFixed(1);
    const half = Math.max(thinnest, radius * 0.95 * (1 - progress) ** 1.3);
    const near = (cross - half).toFixed(2);
    const far = (cross + half).toFixed(2);
    one.push(axis === "x" ? `${point} ${near}` : `${near} ${point}`);
    other.push(axis === "x" ? `${point} ${far}` : `${far} ${point}`);
  }
  motion.lane.setAttribute("d", `M${one.join("L")}L${other.reverse().join("L")}Z`);
}

function draw(motion: ThumbMotion): void {
  if (motions.get(motion.thumb) !== motion) return;
  if (!motion.held && !motion.position.active && !motion.tail.active) {
    finish(motion);
    return;
  }
  const { thumb, axis } = motion;
  const shift = motion.position.value - motion.layout;
  const { x, y } = motion.ownTranslate;
  const translate = axis === "x" ? `calc(${x} + ${shift.toFixed(2)}px) ${y}` : `${x} calc(${y} + ${shift.toFixed(2)}px)`;
  // The thumb stretches along the track with its speed and grows while it is held, as rule 3 says.
  const speed = Math.abs(motion.position.velocity) / Math.max(1, motion.length);
  const stretch = Math.min(stretchMax, speed * stretchPerSpeed);
  const base = motion.held ? heldScale : 1;
  const travel = (base * (1 + stretch)).toFixed(4);
  const cross = (base * (1 - stretch * 0.25)).toFixed(4);
  writeMotionStyle(thumb, { translate, scale: axis === "x" ? `${travel} ${cross}` : `${cross} ${travel}` });
  drawRange(motion, shift);
  drawTail(motion);
}

/** Moves the thumb that people see toward where its component put it. */
function follow(thumb: HTMLElement, value: HTMLElement, from?: number, to?: number): void {
  if (prefersReducedMotion()) {
    const existing = motions.get(thumb);
    if (existing) finish(existing);
    return;
  }
  const existing = motions.get(thumb);
  const motion = existing ?? start(thumb, value);
  if (!motion) return;
  const next = measure(motion);
  if (!existing) {
    // A new motion measured the thumb where its new value put it. It starts where the old value put it.
    const was = from === undefined || to === undefined ? undefined : previousCenter(motion, value, from, to);
    motion.position.set(was ?? next);
  }
  // The layout moved under the thumb that people see: keep it where it is, and spring it to the new place.
  if (Math.abs(next - motion.layout) < 0.01 && existing) return;
  motion.layout = next;
  motion.position.to(next);
  draw(motion);
}

function disabled(value: Element): boolean {
  return value.matches(":disabled, [aria-disabled=true], [data-disabled]:not([data-disabled=false])");
}

/**
 * Drag a value (docs/design/motion.md): a slider thumb from Nuxt UI `USlider`, Reka, ui-sdk and kit, or a plain
 * `[role=slider]`. Its component puts the thumb at the value. The effect keeps the thumb that people see where it was
 * and springs it there, so a tail trails it with its speed and it stretches along the track. A press on the thumb or
 * on its track holds the thumb, and it grows while it is held.
 */
export const slider: MotionEffect = {
  name: "slider",
  // The value, and the track or root around it, so that a press on the track holds the thumb too.
  selector: `${valueSelector}, :has(> [role=slider], > * > [role=slider], > * > input[type=range], > * > * > input[type=range])`,
  press(element, event) {
    if (!(event instanceof PointerEvent)) return;
    const values = element.matches(valueSelector) ? [element] : [...element.querySelectorAll<HTMLElement>(valueSelector)];
    let held: { thumb: HTMLElement; value: HTMLElement } | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const value of values) {
      const thumb = thumbOf(value);
      if (!thumb || disabled(value)) continue;
      const rect = thumb.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - event.clientX, rect.top + rect.height / 2 - event.clientY);
      if (distance < nearest) {
        nearest = distance;
        held = { thumb, value };
      }
    }
    if (!held) return;
    const { thumb, value } = held;
    const motion = motions.get(thumb) ?? start(thumb, value);
    if (!motion) return;
    motion.held = true;
    draw(motion);
    let frame = 0;
    return {
      // ui-sdk moves its thumb on a pointer drag without a change of attribute, so read the thumb after each move.
      move() {
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            follow(thumb, value);
          });
        }
      },
      release() {
        cancelAnimationFrame(frame);
        const current = motions.get(thumb);
        if (!current) return;
        current.held = false;
        follow(thumb, value);
        draw(current);
      },
    };
  },
  state(element, { attribute, oldValue, value }) {
    if (attribute !== "aria-valuenow" && attribute !== "aria-valuetext") return;
    if (!element.matches(valueSelector)) return;
    const thumb = thumbOf(element);
    if (!thumb) return;
    follow(thumb, element, number(oldValue), number(value));
  },
};
