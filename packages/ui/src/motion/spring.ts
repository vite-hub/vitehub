import { prefersReducedMotion } from "./reduced-motion.ts";

/** How stiff a spring is and how fast it loses its speed. */
export interface SpringPreset {
  stiffness: number;
  damping: number;
}

/** The named springs of docs/design/motion.md. Use them, not numbers of your own. */
export const springs = {
  /** Moves and resizes: an indicator that travels, a width that follows its label. */
  snappy: { stiffness: 520, damping: 34 },
  /** Wobbles and settles: a toggled icon, a knob that lands. */
  soft: { stiffness: 380, damping: 20 },
} as const satisfies Record<string, SpringPreset>;

export interface SpringTarget {
  /** Another spring from now on, such as the release of a press. */
  preset?: SpringPreset;
  /** Speed to add, in units of the value per second, such as the speed of a flick. */
  velocity?: number;
  /**
   * Go to the target in this many seconds with an ease-out curve, and not with the spring. Use it for the 150ms
   * crossfade under reduced motion. Without it, a spring jumps to its target under reduced motion.
   */
  tween?: number;
}

export interface Spring {
  readonly value: number;
  readonly velocity: number;
  readonly target: number;
  /** True while the spring moves. */
  readonly active: boolean;
  /** Moves to `target`. A spring that already moves keeps its speed, so a fast second change never jumps. */
  to(target: number, options?: SpringTarget): void;
  /** Jumps to `value` and stops. */
  set(value: number): void;
  /** Stops where it is. */
  stop(): void;
}

/** Called on each frame with the new value and its speed, and once more with the target when the spring settles. */
export type SpringFrame = (value: number, velocity: number) => void;

interface SpringState {
  value: number;
  velocity: number;
  target: number;
  preset: SpringPreset;
  tween: { from: number; elapsed: number; duration: number } | undefined;
  frame: SpringFrame;
}

/**
 * Called on each frame with the motion time since the last frame, in seconds. It is at most 32ms, divided by the slow
 * factor, so ¼× also slows it. Return `false` to stop.
 */
export type FrameStep = (seconds: number) => boolean | void;

const live = new Set<SpringState>();
const steps = new Set<FrameStep>();
let frameId = 0;
let lastTime = 0;
let slowFactor = 1;

/**
 * Makes every spring run `factor` times slower, such as 4 to record at ¼×. 1 is real time. It also slows tweens.
 */
export function setMotionSlowFactor(factor: number): void {
  if (!(factor > 0)) throw new RangeError(`The motion slow factor must be above 0. It is ${factor}.`);
  slowFactor = factor;
}

export function getMotionSlowFactor(): number {
  return slowFactor;
}

// One frame of every live spring and every frame step. The time step is at most 32ms, so a tab that comes back does not throw a spring far
// past its target. Each step runs in 6 parts, as the prototype does, so stiff springs stay stable.
function frame(time: number): void {
  const step = Math.min(0.032, lastTime ? (time - lastTime) / 1000 : 0.016) / slowFactor;
  lastTime = time;
  for (const spring of live) {
    if (spring.tween) {
      const tween = spring.tween;
      tween.elapsed += step;
      const progress = Math.min(1, tween.elapsed / tween.duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = tween.from + (spring.target - tween.from) * eased;
      spring.velocity = (next - spring.value) / (step || 1);
      spring.value = next;
      if (progress >= 1) settle(spring);
    }
    else {
      const { stiffness, damping } = spring.preset;
      const part = step / 6;
      for (let index = 0; index < 6; index++) {
        const force = -stiffness * (spring.value - spring.target) - damping * spring.velocity;
        spring.velocity += force * part;
        spring.value += spring.velocity * part;
      }
      if (Math.abs(spring.velocity) < 0.002 && Math.abs(spring.value - spring.target) < 0.0005) settle(spring);
    }
    spring.frame(spring.value, spring.velocity);
  }
  for (const run of steps) {
    if (run(step) === false) steps.delete(run);
  }
  if (live.size || steps.size) frameId = requestAnimationFrame(frame);
  else {
    frameId = 0;
    lastTime = 0;
  }
}

function settle(spring: SpringState): void {
  spring.value = spring.target;
  spring.velocity = 0;
  spring.tween = undefined;
  live.delete(spring);
}

function start(spring: SpringState): void {
  live.add(spring);
  if (!frameId) frameId = requestAnimationFrame(frame);
}

/**
 * Runs `step` on each frame of the loop of the springs until it returns `false` or the returned function stops it. It
 * moves what is not a spring: a tween, the wave of a progress bar, the dots of a drop field, the fill of a hold.
 */
export function onEachFrame(step: FrameStep): () => void {
  steps.add(step);
  if (!frameId) frameId = requestAnimationFrame(frame);
  return () => {
    steps.delete(step);
  };
}

/** Settles every spring at its target at once. The motion layer calls it when reduced motion turns on. */
export function settleSprings(): void {
  for (const spring of live) {
    settle(spring);
    spring.frame(spring.value, 0);
  }
}

/**
 * A spring on one number, such as a scale amount or a position in pixels. All springs share one frame loop, which
 * stops when no spring moves. `onFrame` writes the value where it belongs.
 */
export function createSpring(initial: number, onFrame: SpringFrame, preset: SpringPreset = springs.snappy): Spring {
  const state: SpringState = { value: initial, velocity: 0, target: initial, preset, tween: undefined, frame: onFrame };
  const spring: Spring = {
    get value() {
      return state.value;
    },
    get velocity() {
      return state.velocity;
    },
    get target() {
      return state.target;
    },
    get active() {
      return live.has(state);
    },
    to(target, options = {}) {
      if (options.preset) state.preset = options.preset;
      if (options.tween === undefined && prefersReducedMotion()) return spring.set(target);
      state.target = target;
      if (options.velocity !== undefined) state.velocity += options.velocity;
      state.tween = options.tween === undefined ? undefined : { from: state.value, elapsed: 0, duration: options.tween };
      start(state);
    },
    set(value) {
      state.value = state.target = value;
      state.velocity = 0;
      state.tween = undefined;
      live.delete(state);
      onFrame(value, 0);
    },
    stop() {
      state.velocity = 0;
      state.tween = undefined;
      live.delete(state);
    },
  };
  return spring;
}
