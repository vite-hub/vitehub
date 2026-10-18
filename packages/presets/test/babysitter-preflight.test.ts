import { afterEach, describe, expect, it, vi } from "vitest";
import { createBabysitterPreflight } from "../src/babysitter/preflight.ts";

afterEach(() => vi.restoreAllMocks());

describe("Babysitter host prerequisites", () => {
  it("coalesces concurrent checks and rechecks missing Corepack after repair", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    let missing = true;
    const command = vi.fn(async (program: string) => { if (program === "corepack" && missing) throw new Error("missing"); });
    const check = createBabysitterPreflight(true, command);
    const [first, second] = await Promise.all([check(), check()]);
    expect(second).toBe(first);
    expect(command.mock.calls).toEqual([["git", "version"]]);
    expect(first.pause).toBeUndefined();
    missing = false;
    await check();
    expect(command).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(31001);
    expect((await check()).pause).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("does not require an installer when installation is disabled", async () => {
    const command = vi.fn(async () => {});
    expect((await createBabysitterPreflight(false, command)()).pause).toBeUndefined();
    expect(command.mock.calls).toEqual([["git", "version"]]);
  });

  it("checks a configured installer executable", async () => {
    const command = vi.fn(async () => {});
    expect((await createBabysitterPreflight({ command: "corepack", args: ["pnpm"] }, command)()).pause).toBeUndefined();
    expect(command.mock.calls).toEqual([["git", "version"], ["corepack", "version"]]);
  });

  it("reports the configured installer when it is unavailable", async () => {
    const command = vi.fn(async (program: string) => { if (program === "bun") throw new Error("missing"); });
    const result = await createBabysitterPreflight({ command: "bun" }, command)();
    expect(result.pause).toMatchObject({ detail: expect.stringContaining("Install bun") });
    expect(result.pause?.detail).not.toContain("Install Corepack");
    expect(command.mock.calls).toEqual([["git", "version"], ["bun", "path"]]);
  });

  it("checks an absolute configured installer executable", async () => {
    const command = vi.fn(async () => {});
    expect((await createBabysitterPreflight({ command: "/opt/vitehub/install" }, command)()).pause).toBeUndefined();
    expect(command.mock.calls).toEqual([["git", "version"], ["/opt/vitehub/install", "path"]]);
  });

  it("rejects an absolute directory even when it has executable permissions", async () => {
    const result = await createBabysitterPreflight({ command: "/tmp" })();
    expect(result.pause).toMatchObject({ reason: "host-prerequisite", detail: expect.stringContaining("Install /tmp") });
  });
});
