import { describe, expect, it } from "vitest";
import { shakeOffset } from "../src/motion/helpers/shake.ts";

describe("shakeOffset", () => {
  it("starts and ends at rest and goes out to 5px on each side", () => {
    expect(shakeOffset(0)).toBe(0);
    expect(shakeOffset(1)).toBe(0);
    expect(shakeOffset(0.4)).toBeCloseTo(5);
    expect(shakeOffset(0.5)).toBeCloseTo(-5);
    const samples = Array.from({ length: 101 }, (_, index) => shakeOffset(index / 100));
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(5.0001);
  });
});
