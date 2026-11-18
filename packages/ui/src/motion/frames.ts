import { getMotionSlowFactor } from "./spring.ts";

/**
 * Called on each frame with the motion time since the last frame, in seconds. It is at most 32ms, divided by the slow
 * factor, so ¼× also slows it. Return `false` to stop.
 */
export type FrameStep = (seconds: number) => boolean | void;

const steps = new Set<FrameStep>();
let frameId = 0;
let lastTime = 0;

function frame(time: number): void {
  const seconds = Math.min(0.032, lastTime ? (time - lastTime) / 1000 : 0.016) / getMotionSlowFactor();
  lastTime = time;
  for (const step of steps) {
    if (step(seconds) === false) steps.delete(step);
  }
  if (steps.size) frameId = requestAnimationFrame(frame);
  else {
    frameId = 0;
    lastTime = 0;
  }
}

/**
 * Runs `step` on each frame until it returns `false` or the returned function stops it. It is the frame loop of the
 * helpers that are not a spring: the wave of a progress bar, the dots of a drop field, the fill of a hold. Like the
 * springs, every step shares one `requestAnimationFrame` loop that stops when nothing runs.
 */
export function onEachFrame(step: FrameStep): () => void {
  steps.add(step);
  if (!frameId) frameId = requestAnimationFrame(frame);
  return () => {
    steps.delete(step);
  };
}

/** A CSS `cubic-bezier()` timing function, so a helper keeps the curve of the prototype. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    // Find t for x by bisection. 20 steps is below a thousandth of a pixel on any bar.
    let low = 0;
    let high = 1;
    let t = progress;
    for (let index = 0; index < 20; index++) {
      t = (low + high) / 2;
      if (curve(x1, x2, t) < progress) low = t;
      else high = t;
    }
    return curve(y1, y2, t);
  };
}

/** The CSS `ease-out` curve. */
export const easeOut = cubicBezier(0, 0, 0.58, 1);

/**
 * Plays a timeline of `duration` seconds of motion time. `draw` gets the progress from 0 to 1 after `easing`. Resolves
 * when it ends, or at once with `false` when `stop()` ended it first.
 */
export function playTween(duration: number, draw: (progress: number) => void, easing: (progress: number) => number = t => t, delay = 0): { done: Promise<boolean>; stop: () => void } {
  let elapsed = -delay;
  let finish: (completed: boolean) => void = () => {};
  const done = new Promise<boolean>(resolve => (finish = resolve));
  const stop = onEachFrame((seconds) => {
    elapsed += seconds;
    if (elapsed < 0) return true;
    const progress = Math.min(1, elapsed / duration);
    draw(easing(progress));
    if (progress < 1) return true;
    finish(true);
    return false;
  });
  return {
    done,
    stop: () => {
      stop();
      finish(false);
    },
  };
}
