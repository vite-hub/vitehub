import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring, SpringPreset } from "../spring.ts";
import { motionSkipped, reduced } from "./frame.ts";

/** A box on the screen, as `getBoundingClientRect()` gives it. */
export interface TravelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TravelOptions {
  /** Where the element starts, such as the place of a picture in the page before it opens larger. */
  from?: TravelBox;
  /**
   * Where the element goes, such as back to the place of the picture when it closes. The element stays there when it
   * lands, until `stop()` or a new travel. Without `to`, the element goes to its own place, and the travel then removes
   * what it wrote.
   */
  to?: TravelBox;
  /** The spring of the travel. Defaults to `springs.snappy`, which moves and resizes. */
  preset?: SpringPreset;
}

export interface Travel {
  /** True when the element landed, false when the travel stopped, was replaced, or had no motion. */
  done: Promise<boolean>;
  /** Stops the travel and removes what it wrote. */
  stop(): void;
}

/** The `translate` and `scale` that put an element whose box is `rest` on `box`, scaled around `origin`. */
export interface TravelOffset {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/**
 * The offset that draws a box `rest` as the box `box`, when the scale turns around the point `origin` of the screen.
 * The layer writes the separate `translate` and `scale` properties, which apply around the same point as the element's
 * own transform, so the element can keep a transform of its own.
 */
export function travelOffset(rest: TravelBox, origin: { x: number; y: number }, box: TravelBox): TravelOffset {
  const scaleX = rest.width ? box.width / rest.width : 1;
  const scaleY = rest.height ? box.height / rest.height : 1;
  return {
    x: box.left - origin.x - scaleX * (rest.left - origin.x),
    y: box.top - origin.y - scaleY * (rest.top - origin.y),
    scaleX,
    scaleY,
  };
}

interface Running {
  x: Spring;
  y: Spring;
  scaleX: Spring;
  scaleY: Spring;
  stop(): void;
}

const running = new WeakMap<HTMLElement, Running>();
const rest: TravelOffset = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

/** The element's box with nothing of the travel written, and the point of the screen that its scale turns around. */
function measure(element: HTMLElement): { box: DOMRect; origin: { x: number; y: number } } {
  const { translate, scale } = element.style;
  writeMotionStyle(element, { translate: null, scale: null });
  const box = element.getBoundingClientRect();
  // A scale of one half moves each corner halfway to the origin, so the origin is twice the half box less the box.
  writeMotionStyle(element, { scale: "0.5" });
  const half = element.getBoundingClientRect();
  writeMotionStyle(element, { translate, scale });
  return { box, origin: { x: 2 * half.left - box.left, y: 2 * half.top - box.top } };
}

/**
 * Rule 8 for a thing that moves to a new place: a picture that opens larger from where it is in the page, and goes back
 * there when it closes. The element travels from `from` to its own place, or from where it is to `to`, on a spring for
 * each of its position and its size, and keeps its speed when a new travel starts in the middle of one.
 *
 * The page lays the element out at its new place first; the travel only draws it on the way there, with `translate`
 * and `scale`. Under reduced motion and inside `data-motion="none"` the element is at its place at once, and `done` is
 * false.
 */
export function travel(element: HTMLElement, options: TravelOptions): Travel {
  const previous = running.get(element);
  if (motionSkipped(element) || reduced()) {
    previous?.stop();
    return { done: Promise.resolve(false), stop() {} };
  }
  const { box, origin } = measure(element);
  const start = options.from ? travelOffset(box, origin, options.from) : undefined;
  const target = options.to ? travelOffset(box, origin, options.to) : rest;
  const preset = options.preset ?? springs.snappy;

  let finish!: (landed: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const draw = () => {
    if (running.get(element) !== motion) return;
    writeMotionStyle(element, {
      translate: `${motion.x.value}px ${motion.y.value}px`,
      scale: `${motion.scaleX.value} ${motion.scaleY.value}`,
    });
    if ([motion.x, motion.y, motion.scaleX, motion.scaleY].some(spring => spring.active)) return;
    if (!options.to) {
      running.delete(element);
      writeMotionStyle(element, { translate: null, scale: null });
    }
    finish(true);
  };
  // A travel in the middle of another one starts where the element is now, with its speed.
  const spring = (key: keyof TravelOffset) => {
    const value = start?.[key] ?? previous?.[key].value ?? rest[key];
    const made = createSpring(value, draw, preset);
    const velocity = start ? 0 : previous?.[key].velocity ?? 0;
    return { made, velocity };
  };
  const parts = { x: spring("x"), y: spring("y"), scaleX: spring("scaleX"), scaleY: spring("scaleY") };
  const motion: Running = {
    x: parts.x.made,
    y: parts.y.made,
    scaleX: parts.scaleX.made,
    scaleY: parts.scaleY.made,
    stop() {
      if (running.get(element) !== motion) return;
      for (const key of ["x", "y", "scaleX", "scaleY"] as const) motion[key].stop();
      running.delete(element);
      writeMotionStyle(element, { translate: null, scale: null });
      finish(false);
    },
  };
  previous?.stop();
  running.set(element, motion);
  for (const key of ["x", "y", "scaleX", "scaleY"] as const) parts[key].made.to(target[key], { velocity: parts[key].velocity });
  draw();

  return { done, stop: motion.stop };
}
