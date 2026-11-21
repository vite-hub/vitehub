import { describe, expect, it } from "vitest";
import { travelOffset } from "../src/motion/helpers/travel.ts";

/** Where `offset` draws the box `rest`, scaled around `origin`, then moved. */
function drawn(rest: { left: number; top: number; width: number; height: number }, origin: { x: number; y: number }, offset: ReturnType<typeof travelOffset>) {
  return {
    left: origin.x + offset.scaleX * (rest.left - origin.x) + offset.x,
    top: origin.y + offset.scaleY * (rest.top - origin.y) + offset.y,
    width: rest.width * offset.scaleX,
    height: rest.height * offset.scaleY,
  };
}

describe("travelOffset", () => {
  const rest = { left: 100, top: 50, width: 800, height: 600 };

  it("draws the box at rest on the box it starts from, for any origin of the scale", () => {
    const from = { left: 20, top: 400, width: 200, height: 150 };
    for (const origin of [{ x: 500, y: 350 }, { x: 100, y: 50 }, { x: -40, y: 1200 }]) {
      const offset = travelOffset(rest, origin, from);
      const box = drawn(rest, origin, offset);
      expect(box.left).toBeCloseTo(from.left);
      expect(box.top).toBeCloseTo(from.top);
      expect(box.width).toBeCloseTo(from.width);
      expect(box.height).toBeCloseTo(from.height);
    }
  });

  it("is no offset for the box at rest", () => {
    expect(travelOffset(rest, { x: 500, y: 350 }, rest)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
  });

  it("keeps a scale of 1 for a box with no size", () => {
    const offset = travelOffset({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 }, { left: 10, top: 20, width: 30, height: 40 });
    expect(offset).toEqual({ x: 10, y: 20, scaleX: 1, scaleY: 1 });
  });
});
