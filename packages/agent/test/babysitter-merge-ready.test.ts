import { afterEach, expect, it, vi } from "vitest";
import { boundedMergeReady } from "../src/presets/babysitter/merge-ready.ts";

afterEach(() => vi.useRealTimers());

it("times out a never-settling readiness callback without an owner signal", async () => {
  vi.useFakeTimers();
  const result = boundedMergeReady(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("merge readiness timed out");
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a claimed readiness callback when its owner aborts", async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const result = boundedMergeReady(() => new Promise(() => {}), owner.signal);
  owner.abort();
  expect(await result).toBe("merge readiness cancelled");
  expect(vi.getTimerCount()).toBe(0);
});

it("contains rejection and permits a later readiness evaluation", async () => {
  expect(await boundedMergeReady(() => Promise.reject(new Error("unavailable")))).toBe("merge readiness check failed");
  expect(await boundedMergeReady(() => true)).toBe(true);
});
