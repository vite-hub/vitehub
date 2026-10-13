import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveBox } from "../src/index.ts";
import { createSessionMemory } from "../src/internal/session-memory.ts";
import { createTrustedHostRuntime, type TrustedHostOptions } from "../src/internal/trusted-host.ts";

vi.mock("../src/internal/session-memory.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/internal/session-memory.ts")>(),
  createSessionMemory: vi.fn(async () => ({
    assertHealthy: async () => {},
    close: async () => {},
    kill: async () => {},
  })),
}));

describe("trusted-host resource snapshots", () => {
  it("uses the inspected budget for every session after caller mutations", async () => {
    vi.mocked(createSessionMemory).mockClear();
    const resources = { cgroupParent: "/delegated", memoryMaxBytes: 1024, memoryHighBytes: 512, memorySwapMaxBytes: 0 };
    const runtime = { kind: "trusted-host" as const, resources };
    const box = await resolveBox({ runtime }, {});
    const expected = { ...resources };
    Object.assign(resources, { cgroupParent: "/other", memoryMaxBytes: 2048, memoryHighBytes: 1536, memorySwapMaxBytes: 1024 });
    runtime.resources = { ...resources, memoryMaxBytes: 4096 };
    expect(box.plan.resources).toEqual(expected);
    expect(Object.isFrozen(box.plan.resources)).toBe(true);
    for (let index = 0; index < 2; index++) {
      const session = await box.open();
      try {
        expect(createSessionMemory).toHaveBeenLastCalledWith(expected);
      } finally {
        await session.close();
      }
    }
  });

  it("rejects a pending launch when teardown starts during its health check", async () => {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    const spawn = vi.fn(() => { throw new Error("late launcher executed"); });
    vi.mocked(createSessionMemory).mockResolvedValueOnce({
      assertHealthy: async () => { enter(); await resumed; },
      close: async () => {},
      kill: async () => {},
      spawn,
    });
    const box = await resolveBox({
      runtime: { kind: "trusted-host", resources: { cgroupParent: "/delegated", memoryMaxBytes: 1024 } },
    }, {});
    const session = await box.open();
    if (!session.spawn) throw new Error("trusted-host must support spawn");
    const launch = session.spawn("echo", ["should-not-run"]);
    const rejected = expect(launch).rejects.toThrow("Trusted host Box session is closing.");
    await entered;
    try {
      await session.close();
    } finally {
      resume();
    }
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("retains the state lease after failed cgroup cleanup until close succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "box-cleanup-lease-"));
    const close = vi.fn().mockRejectedValueOnce(new Error("cgroup remains populated")).mockResolvedValue(undefined);
    vi.mocked(createSessionMemory).mockResolvedValueOnce({ assertHealthy: async () => {}, close, kill: async () => {}, spawn: vi.fn() });
    const box = await resolveBox({
      home: { state: { ".state": { key: "cleanup-lease" } } },
      runtime: createTrustedHostRuntime({ stateRoot: root, resources: { cgroupParent: "/delegated", memoryMaxBytes: 1024 } }),
    }, {});
    const first = await box.open();
    try {
      await expect(first.close()).rejects.toThrow("cgroup remains populated");
      await expect(box.open({ signal: AbortSignal.timeout(100) })).rejects.toThrow();
      await first.close();
      const second = await box.open({ signal: AbortSignal.timeout(1000) });
      await second.close();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains initialized state and its lease until failed-open teardown succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "box-failed-open-state-"));
    const key = "failed-open-state";
    const persistent = join(root, createHash("sha256").update(key).digest("hex"));
    let populated = true;
    const close = vi.fn(async () => {
      if (populated) throw new Error("cgroup remains populated");
      // State must still exist until all descendants have exited.
      expect(await readFile(join(persistent, "value"), "utf8")).toBe("seed");
    });
    vi.mocked(createSessionMemory).mockResolvedValueOnce({ assertHealthy: async () => {}, close, kill: async () => {}, spawn: vi.fn() });
    const box = await resolveBox({
      home: { state: { ".state": { key, seed: { value: { contents: "seed" } } } } },
      runtime: createTrustedHostRuntime({ stateRoot: root, resources: { cgroupParent: "/delegated", memoryMaxBytes: 1024 } }),
    }, {});
    try {
      await expect(box.open({ initialize: async () => { throw new Error("initialization failed"); } })).rejects.toThrow("initialization failed");
      expect(await readFile(join(persistent, "value"), "utf8")).toBe("seed");
      await expect(box.open({ signal: AbortSignal.timeout(100) })).rejects.toThrow();
      populated = false;
      await expect.poll(async () => stat(persistent).then(() => true, () => false)).toBe(false);
      const next = await box.open({ signal: AbortSignal.timeout(1000) });
      await next.close();
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      populated = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not add limits to a plan prepared without resources", async () => {
    vi.mocked(createSessionMemory).mockClear();
    const options: TrustedHostOptions = {};
    const box = await resolveBox({ runtime: createTrustedHostRuntime(options) }, {});
    options.resources = { cgroupParent: "/delegated", memoryMaxBytes: 1024 };
    const session = await box.open();
    try {
      expect(box.plan.resources).toBeUndefined();
      expect(createSessionMemory).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
