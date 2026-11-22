import { writeMotionStyle } from "../registry.ts";
import { motionSkipped, reduced } from "./frame.ts";
import { cubicBezier, playTween } from "./tween.ts";

// The shake of the comment box: 400ms, out to 5px and back, each step on this curve, as its CSS animation did.
const duration = 0.4;
const step = cubicBezier(0.36, 0.07, 0.19, 0.97);
const frames: Array<[number, number]> = [[0, 0], [0.1, -1], [0.2, 3], [0.3, -5], [0.4, 5], [0.5, -5], [0.6, 5], [0.7, -5], [0.8, 3], [0.9, -1], [1, 0]];

const shaking = new WeakMap<HTMLElement, () => void>();

/** The offset in pixels at `progress` of the shake: each step between two frames runs on the curve. */
export function shakeOffset(progress: number): number {
  const index = Math.max(0, frames.findIndex(([at]) => at >= progress) - 1);
  const [fromAt, from] = frames[index]!;
  const [toAt, to] = frames[index + 1] ?? frames[index]!;
  const local = toAt > fromAt ? (progress - fromAt) / (toAt - fromAt) : 1;
  return from + (to - from) * step(Math.min(1, Math.max(0, local)));
}

/**
 * Shakes `element` from side to side once, when it refuses an action but keeps what the person wrote, such as a comment
 * box that Esc did not close. A second call starts the shake again. Under reduced motion and inside
 * `data-motion="none"` it does nothing: show the refusal with a color instead.
 */
export function shake(element: HTMLElement): void {
  shaking.get(element)?.();
  if (motionSkipped(element) || reduced()) return;
  const timeline = playTween(duration, progress => writeMotionStyle(element, { translate: progress >= 1 ? null : `${shakeOffset(progress).toFixed(2)}px 0` }));
  const stop = () => {
    timeline.stop();
    shaking.delete(element);
    writeMotionStyle(element, { translate: null });
  };
  shaking.set(element, stop);
  void timeline.done.then(completed => completed && stop());
}
