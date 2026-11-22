import { isMotionOff } from "../layer.ts";
import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

const followSpring = { stiffness: 520, damping: 38 };
const trail = { stiffness: 260, damping: 30 };
const heldScale = 1.12;
const tailMax = 150;
const tailPerSpeed = 0.13;
const turnSpeed = 0.05;
const tailPoints = 28;
const stretchPerSpeed = 0.09;
const stretchMax = 0.55;

const svgNamespace = "http://www.w3.org/2000/svg";
const valueSelector = "[role=slider], input[type=range]";
const nativeThumb = "[data-slot=slider-thumb]";
const rangeSelector = "[data-slot=range], [data-slot=slider-indicator]";
const trackSelector = "[data-slot=track], [data-slot=slider-track], :has(> [data-slot=range])";

type Axis = "x" | "y";

interface ThumbMotion {
  thumb: HTMLElement;
  track: HTMLElement;
  range: HTMLElement | null;
  axis: Axis;
  layout: number;
  length: number;
  zoom: number;
  direction: 1 | -1;
  held: boolean;
  position: Spring;
  tail: Spring;
  ownTranslate: { raw: string; x: string; y: string };
  lane?: SVGPathElement;
}

const motions = new WeakMap<HTMLElement, ThumbMotion>();
const fills = new WeakMap<HTMLElement, { minSize: string; translate: string; scale: string; shift: number }>();

function thumbOf(element: HTMLElement): HTMLElement | undefined {
  if (!(element instanceof HTMLInputElement)) return element;
  const parent = element.parentElement;
  return parent?.matches(nativeThumb) ? parent : undefined;
}

function trackValues(track: HTMLElement): NodeListOf<HTMLElement> {
  return track.querySelectorAll<HTMLElement>(`:scope > [role=slider], :scope > ${nativeThumb} > input[type=range]`);
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

function directionOf({ thumb, axis }: ThumbMotion): number {
  const { style } = thumb;
  const forward = axis === "x" ? style.left : style.top;
  const backward = axis === "x" ? style.right : style.bottom;
  if (forward && !backward) return 1;
  if (backward && !forward) return -1;
  return axis === "y" || getComputedStyle(thumb).direction === "rtl" ? -1 : 1;
}

function previousCenter(motion: ThumbMotion, value: HTMLElement, from: number, to: number): number | undefined {
  const min = number(value.getAttribute("aria-valuemin") ?? value.getAttribute("min"));
  const max = number(value.getAttribute("aria-valuemax") ?? value.getAttribute("max"));
  const minimum = Number.isFinite(min) ? min : 0;
  const maximum = Number.isFinite(max) ? max : 100;
  if (!(maximum > minimum) || !Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const size = along(rectOf(motion.thumb, motion), motion.axis).size;
  const fraction = (to - minimum) / (maximum - minimum);
  const signAtMidpoint = directionOf(motion);
  let best: { error: number; travel: number; sign: number } | undefined;
  for (const travel of [motion.length - size, motion.length]) {
    for (const sign of [signAtMidpoint, -signAtMidpoint]) {
      const predicted = motion.length / 2 + sign * (fraction - 0.5) * travel;
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
    range: track.querySelector<HTMLElement>(":scope > [data-slot=range], :scope > [data-slot=slider-indicator]"),
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
  drawRange(motion);
  motion.lane?.ownerSVGElement?.remove();
}

function drawRange(motion: ThumbMotion): void {
  const { range, axis, track } = motion;
  if (!range) return;
  const endpoints = [...trackValues(track)].flatMap(value => {
    const thumb = thumbOf(value);
    if (!thumb) return [];
    const current = motions.get(thumb);
    const box = along(rectOf(thumb, motion), axis);
    return [{ center: box.start + box.size / 2, moving: !!current && Math.abs(current.position.value - current.layout) >= 0.01 }];
  });
  const minSize = axis === "x" ? "minWidth" : "minHeight";
  let fill = fills.get(range);
  if (!endpoints.some(endpoint => endpoint.moving)) {
    if (fill) {
      range.style[minSize] = fill.minSize;
      writeMotionStyle(range, { translate: fill.translate, scale: fill.scale });
      fills.delete(range);
    }
    return;
  }
  if (!fill) {
    fill = { minSize: range.style[minSize], scale: range.style.scale, translate: range.style.translate, shift: 0 };
    fills.set(range, fill);
    range.style[minSize] = "1px";
  }
  const size = Number.parseFloat(getComputedStyle(range)[axis === "x" ? "width" : "height"]);
  if (!(size > 0)) return;
  const box = along(rectOf(range, motion), axis);
  const start = box.start + box.size / 2 - fill.shift - size / 2;
  const end = start + size;
  const centers = endpoints.map(endpoint => endpoint.center);
  let from = Math.min(...centers);
  let to = Math.max(...centers);
  if (endpoints.length === 1) {
    if (directionOf(motion) > 0) from = start;
    else to = end;
  }
  const scale = Math.max(0, to - from) / size;
  const move = fill.shift = (from + to) / 2 - (start + end) / 2;
  writeMotionStyle(range, {
    translate: axis === "x" ? `${move}px 0px` : `0px ${move}px`,
    scale: axis === "x" ? `${scale} 1` : `1 ${scale}`,
  });
}

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
  const radius = (axis === "x" ? thumbRect.height : thumbRect.width) / 2 / (motion.held ? heldScale : 1);
  const cross = axis === "x" ? thumbRect.top + thumbRect.height / 2 - origin.top : thumbRect.left + thumbRect.width / 2 - origin.left;
  const trackStart = (axis === "x" ? trackRect.left - origin.left : trackRect.top - origin.top);
  const at = Math.max(0, Math.min(length, motion.position.value));
  const reach = Math.min(tail, direction > 0 ? at : length - at);
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
  const speed = Math.abs(motion.position.velocity) / Math.max(1, motion.length);
  const stretch = Math.min(stretchMax, speed * stretchPerSpeed);
  const base = motion.held ? heldScale : 1;
  const travel = (base * (1 + stretch)).toFixed(4);
  const cross = (base * (1 - stretch * 0.25)).toFixed(4);
  writeMotionStyle(thumb, { translate, scale: axis === "x" ? `${travel} ${cross}` : `${cross} ${travel}` });
  drawRange(motion);
  drawTail(motion);
}

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
    const was = from === undefined || to === undefined ? undefined : previousCenter(motion, value, from, to);
    motion.position.set(was ?? next);
  }
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
  selector: `${valueSelector}, ${trackSelector}, [data-slot=slider-control]`,
  press(element, event) {
    if (!(event instanceof PointerEvent)) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) return;
    const track = element.matches("[data-slot=slider-control]") ? element.querySelector<HTMLElement>("[data-slot=slider-track]") : element;
    const values = element.matches(valueSelector) ? [element] :
      track && (target === element || target === track || target.closest(rangeSelector)?.parentElement === track) ? trackValues(track) : [];
    let held: { thumb: HTMLElement; value: HTMLElement } | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const value of values) {
      const thumb = thumbOf(value);
      if (!thumb || disabled(value) || isMotionOff(value)) continue;
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
