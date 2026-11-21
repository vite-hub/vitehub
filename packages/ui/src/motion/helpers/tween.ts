import { createSpring } from "../spring.ts";

/** An easing curve: progress from 0 to 1 in, eased progress out. */
export type Ease = (progress: number) => number;

/** The CSS `cubic-bezier()` curve, so a helper uses the same curves as the prototype. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
    let low = 0;
    let high = 1;
    let t = x;
    for (let step = 0; step < 24; step++) {
      if (at(t, x1, x2) < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return at(t, y1, y2);
  };
}

export const linear: Ease = progress => progress;
export const easeIn = cubicBezier(0.42, 0, 1, 1);
export const easeOut = cubicBezier(0, 0, 0.58, 1);

export interface TweenOptions {
  /** Milliseconds at 1×. */
  duration: number;
  /** Milliseconds at 1× before the value starts to change. */
  delay?: number;
  ease?: Ease;
}

export interface Tween {
  stop(): void;
}

/**
 * Moves a value from `from` to `to` on the shared frame loop of the motion layer, so ¼× slows it and it stops with the
 * other springs. `onFrame` gets the value on each frame, and `onDone` runs once at the end. The spring of the loop
 * tweens 0 to 1 with a cubic ease-out, so each frame first turns that value back into linear time.
 */
export function tween(from: number, to: number, options: TweenOptions, onFrame: (value: number) => void, onDone?: () => void): Tween {
  const delay = options.delay ?? 0;
  const total = delay + options.duration;
  const ease = options.ease ?? linear;
  let done = false;
  const spring = createSpring(0, (eased) => {
    if (done) return;
    const time = (1 - Math.cbrt(1 - Math.min(1, eased))) * total;
    const progress = Math.min(1, Math.max(0, (time - delay) / options.duration));
    onFrame(from + (to - from) * ease(progress));
    if (eased >= 1) {
      done = true;
      onDone?.();
    }
  });
  spring.to(1, { tween: total / 1000 });
  return {
    stop() {
      done = true;
      spring.stop();
    },
  };
}
