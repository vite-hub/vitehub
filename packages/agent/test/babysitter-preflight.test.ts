import { afterEach, describe, expect, it, vi } from "vitest";
import { createBabysitterPreflight } from "../src/presets/babysitter/preflight.ts";

afterEach(() => vi.restoreAllMocks());

describe("Babysitter host prerequisites", () => {
  it("coalesces concurrent checks and rechecks missing Corepack after repair", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    let missing = true;
    const command = vi.fn(async (program: string) => { if (program === "corepack" && missing) throw new Error("missing"); });
    const check = createBabysitterPreflight(true, command);
    const [first, second] = await Promise.all([check(), check()]);
    expect(second).toBe(first);
    expect(command.mock.calls).toEqual([["git"], ["corepack"]]);
    expect(first.pause).toMatchObject({ reason: "host-prerequisite", detail: expect.stringContaining("Install Corepack"), retryAt: 31000 });
    missing = false;
    await check();
    expect(command).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(31001);
    expect((await check()).pause).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(4);
  });

  it.each([false, { command: "custom-installer" }] as const)("does not require Corepack when installation is %j", async install => {
    const command = vi.fn(async () => {});
    expect((await createBabysitterPreflight(install, command)()).pause).toBeUndefined();
    expect(command.mock.calls).toEqual([["git"]]);
  });
});
