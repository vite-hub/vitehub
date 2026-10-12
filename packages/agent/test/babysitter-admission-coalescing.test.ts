import { expect, it } from "vitest";
import { coalesceBabysitterAdmission } from "../src/presets/babysitter/admission.ts";

it("shares fresh dispatch accounting while health uses only a bounded cached result", async () => {
  let now = 1_000, reads = 0;
  let release!: () => void;
  const check = coalesceBabysitterAdmission(async () => {
    reads++;
    if (reads > 1) await new Promise<void>(resolve => { release = resolve; });
    return { accepting: true, tokens: reads * 10 };
  }, () => now);
  const first = await check();
  now += 60_000;
  const refresh = check();
  const anotherDispatch = check();
  await Promise.resolve();
  expect(reads).toBe(2);
  expect((await check.health()).tokens).toBe(first.tokens);
  now += 60_001;
  let finished = false;
  const expiredHealth = check.health().then(value => { finished = true; return value; });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  const [fresh, same, healthy] = await Promise.all([refresh, anotherDispatch, expiredHealth]);
  expect(fresh.tokens).toBe(20);
  expect(same).toBe(fresh);
  expect(healthy).toBe(fresh);
  expect(healthy.observedAt).toBe(now);
});
