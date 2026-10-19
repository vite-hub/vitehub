import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBabysitterPreflight } from "../src/babysitter/preflight.ts";

afterEach(() => vi.restoreAllMocks());

describe("Babysitter host prerequisites", () => {
  it("coalesces concurrent checks and caches successful automatic checks", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const command = vi.fn(async () => {});
    const check = createBabysitterPreflight(true, command);
    const [first, second] = await Promise.all([check(), check()]);
    expect(second).toBe(first);
    expect(command.mock.calls).toEqual([["git", "version"]]);
    expect(first.pause).toBeUndefined();
    await check();
    expect(command).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(301001);
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

  it("resolves env shebangs past assignments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-preflight-"));
    const executable = join(directory, "installer");
    try {
      await writeFile(executable, "#!/usr/bin/env FOO=bar node\nconsole.log('ok')\n");
      await chmod(executable, 0o755);
      const result = await createBabysitterPreflight({ command: executable })();
      expect(result.pause).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
