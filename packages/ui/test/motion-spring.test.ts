import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forceReducedMotion } from "../src/motion/reduced-motion.ts";
import { createSpring, setMotionSlowFactor, springs } from "../src/motion/spring.ts";

// A frame clock that the test advances by hand, 60 frames per second.
let queue: FrameRequestCallback[] = [];
let now = 0;
let requests = 0;

function tick(frames = 1): void {
  for (let index = 0; index < frames; index++) {
    const callbacks = queue;
    queue = [];
    now += 1000 / 60;
    for (const callback of callbacks) callback(now);
  }
}

/** Frames until the loop stops, up to `limit`. */
function framesUntilIdle(limit = 2000): number {
  let frames = 0;
  while (queue.length && frames < limit) {
    tick();
    frames++;
  }
  return frames;
}

beforeEach(() => {
  queue = [];
  now = 0;
  requests = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    requests++;
    queue.push(callback);
    return requests;
  });
});

afterEach(() => {
  framesUntilIdle();
  setMotionSlowFactor(1);
  forceReducedMotion(undefined);
  vi.unstubAllGlobals();
});

describe("createSpring", () => {
  it("converges on its target and reports the exact target last", () => {
    const values: number[] = [];
    const spring = createSpring(0, value => values.push(value));
    spring.to(100);
    framesUntilIdle();
    expect(values.at(-1)).toBe(100);
    expect(spring.value).toBe(100);
    expect(spring.velocity).toBe(0);
    expect(spring.active).toBe(false);
  });

  it("keeps its speed when it gets a new target", () => {
    const spring = createSpring(0, () => {});
    spring.to(100);
    tick(2);
    const speed = spring.velocity;
    expect(speed).toBeGreaterThan(0);
    spring.to(-100);
    // The speed has not jumped to zero or reversed: the spring still moves toward 100 on the next frame.
    expect(spring.velocity).toBe(speed);
    const before = spring.value;
    tick();
    expect(spring.value).toBeGreaterThan(before);
  });

  it("adds the speed of a flick", () => {
    const spring = createSpring(0, () => {});
    spring.to(0, { velocity: 500 });
    tick();
    expect(spring.value).toBeGreaterThan(0);
  });

  it.each([["snappy", springs.snappy, 0.6], ["soft", springs.soft, 1.2]] as const)("settles the %s preset in under %ss", (_name, preset, seconds) => {
    const spring = createSpring(0, () => {}, preset);
    spring.to(1);
    expect(framesUntilIdle() / 60).toBeLessThan(seconds);
  });

  it("passes rest further with the soft preset than with the snappy preset", () => {
    const peak = (preset: { stiffness: number; damping: number }) => {
      let max = 0;
      createSpring(0, value => (max = Math.max(max, value)), preset).to(1);
      framesUntilIdle();
      return max;
    };
    expect(peak(springs.soft)).toBeGreaterThan(1.1);
    expect(peak(springs.snappy)).toBeLessThan(1.05);
  });

  it("asks for frames only while a spring moves", () => {
    const spring = createSpring(0, () => {});
    expect(queue).toHaveLength(0);
    spring.to(1);
    spring.to(2);
    // One loop for both calls, and for every spring.
    createSpring(0, () => {}).to(1);
    expect(queue).toHaveLength(1);
    framesUntilIdle();
    expect(queue).toHaveLength(0);
    const asked = requests;
    tick(10);
    expect(requests).toBe(asked);
  });

  it("runs as many times slower as the slow factor", () => {
    const run = () => {
      createSpring(0, () => {}).to(1);
      return framesUntilIdle();
    };
    const real = run();
    setMotionSlowFactor(4);
    const slow = run();
    expect(slow / real).toBeGreaterThan(3.8);
    expect(slow / real).toBeLessThan(4.2);
  });

  it("goes to its target in the given seconds with a tween", () => {
    const spring = createSpring(0, () => {});
    spring.to(1, { tween: 0.15 });
    // The first frame counts 16ms, and the next ones 1/60 s each: 0.150s ends in the 10th frame.
    expect(framesUntilIdle()).toBe(10);
    expect(spring.value).toBe(1);
  });

  it("jumps to its target under reduced motion, but still runs a tween", () => {
    forceReducedMotion(true);
    const values: number[] = [];
    const spring = createSpring(0, value => values.push(value));
    spring.to(1);
    expect(values).toEqual([1]);
    expect(queue).toHaveLength(0);
    spring.to(0, { tween: 0.15 });
    expect(spring.active).toBe(true);
  });

  it("refuses a slow factor that is not above 0", () => {
    expect(() => setMotionSlowFactor(0)).toThrow(RangeError);
  });
});
