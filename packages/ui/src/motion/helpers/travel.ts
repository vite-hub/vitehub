import { onReducedMotionChange } from "../reduced-motion.ts";
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
  /** Where the element starts. Defaults to the last drawn box during a travel, or to the element's own place. */
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
  parts: Record<keyof TravelBox, Spring>;
  stop(): void;
}

const running = new WeakMap<HTMLElement, Running>();
const keys = ["left", "top", "width", "height"] as const;

/** The element's box with nothing of the travel written, and the point of the screen that its scale turns around. */
function measure(element: HTMLElement) {
  const { translate, scale } = element.style;
  writeMotionStyle(element, { translate: null, scale: null });
  const box = element.getBoundingClientRect();
  // A scale of one half moves each corner halfway to the origin, so the origin is twice the half box less the box.
  writeMotionStyle(element, { scale: "0.5" });
  const half = element.getBoundingClientRect();
  writeMotionStyle(element, { translate: "100px 100px" });
  const shifted = element.getBoundingClientRect();
  writeMotionStyle(element, { translate, scale });
  return {
    box,
    origin: { x: 2 * half.left - box.left, y: 2 * half.top - box.top },
    pixels: { x: (shifted.left - half.left) / 100 || 1, y: (shifted.top - half.top) / 100 || 1 },
  };
}

/**
 * Rule 8 for a thing that moves to a new place: a picture that opens larger from where it is in the page, and goes back
 * there when it closes. The element travels from `from` to its own place, or from where it is to `to`, on a spring for
 * each of its position and its size, and keeps its speed when a new travel starts in the middle of one.
 *
 * The page lays the element out at its new place first; the travel only draws it on the way there, with `translate`
 * and `scale`. Under reduced motion and inside `data-motion="none"` a new travel leaves the element at its own place,
 * and `done` is false. If reduced motion turns on during a travel, it lands at once.
 */
export function travel(element: HTMLElement, options: TravelOptions): Travel {
  const previous = running.get(element);
  if (motionSkipped(element) || reduced()) {
    previous?.stop();
    return { done: Promise.resolve(false), stop() {} };
  }
  const { box, origin, pixels } = measure(element);
  const target = options.to ?? box;
  const preset = options.preset ?? springs.snappy;

  let finish!: (landed: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const draw = () => {
    if (running.get(element) !== motion) return;
    const offset = travelOffset(box, origin, {
      left: parts.left.value, top: parts.top.value, width: parts.width.value, height: parts.height.value,
    });
    writeMotionStyle(element, {
      translate: `${offset.x / pixels.x}px ${offset.y / pixels.y}px`,
      scale: `${offset.scaleX} ${offset.scaleY}`,
    });
    if (keys.some(key => parts[key].active)) return;
    unwatch();
    if (!options.to) {
      running.delete(element);
      writeMotionStyle(element, { translate: null, scale: null });
    }
    finish(true);
  };
  // A travel in the middle of another one starts where the element is now, with its speed.
  const spring = (key: keyof TravelBox) => createSpring(options.from?.[key] ?? previous?.parts[key].value ?? box[key], draw, preset);
  const parts = { left: spring("left"), top: spring("top"), width: spring("width"), height: spring("height") };
  const velocity = keys.map(key => previous?.parts[key].velocity ?? 0);
  const unwatch = onReducedMotionChange((isReduced) => {
    if (isReduced) for (const key of keys) parts[key].set(target[key]);
  });
  const motion: Running = {
    parts,
    stop() {
      if (running.get(element) !== motion) return;
      unwatch();
      for (const key of keys) parts[key].stop();
      running.delete(element);
      writeMotionStyle(element, { translate: null, scale: null });
      finish(false);
    },
  };
  previous?.stop();
  running.set(element, motion);
  keys.forEach((key, index) => parts[key].to(target[key], { velocity: velocity[index] }));
  draw();

  return { done, stop: motion.stop };
}
