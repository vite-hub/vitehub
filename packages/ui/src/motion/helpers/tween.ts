import { onEachFrame } from "../spring.ts";

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
 * Moves a value from `from` to `to` on the shared frame loop of the motion layer, so ¼× slows it. `onFrame` gets the
 * value on each frame, also `from` while the delay runs, and `onDone` runs once at the end.
 */
export function tween(from: number, to: number, options: TweenOptions, onFrame: (value: number) => void, onDone?: () => void): Tween {
  const delay = (options.delay ?? 0) / 1000;
  const duration = options.duration / 1000;
  const ease = options.ease ?? linear;
  let elapsed = 0;
  const stop = onEachFrame((seconds) => {
    elapsed += seconds;
    const progress = duration > 0 ? Math.min(1, Math.max(0, (elapsed - delay) / duration)) : elapsed >= delay ? 1 : 0;
    onFrame(from + (to - from) * ease(progress));
    if (progress < 1) return true;
    onDone?.();
    return false;
  });
  return { stop };
}

/**
 * Plays a timeline of `duration` seconds after `delay` seconds. `draw` gets the progress from 0 to 1 after `ease`. `done`
 * resolves with `true` when it ends, or with `false` when `stop()` ended it first.
 */
export function playTween(duration: number, draw: (progress: number) => void, ease: Ease = linear, delay = 0): { done: Promise<boolean>; stop: () => void } {
  let finish: (completed: boolean) => void = () => {};
  const done = new Promise<boolean>(resolve => (finish = resolve));
  const timeline = tween(0, 1, { duration: duration * 1000, delay: delay * 1000, ease }, draw, () => finish(true));
  return {
    done,
    stop: () => {
      timeline.stop();
      finish(false);
    },
  };
}
