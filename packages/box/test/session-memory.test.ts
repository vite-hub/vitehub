import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBox } from "../src/index.ts";

const MiB = 1024 ** 2;

async function limitedBox(cgroupParent: string, memoryMaxBytes = 96 * MiB) {
  return await resolveBox({ runtime: {
    kind: "trusted-host",
    resources: { cgroupParent, memoryMaxBytes, memorySwapMaxBytes: 0 },
  } }, {});
}

describe("trusted-host session memory", () => {
  it("fails closed when a delegated cgroup is unavailable", async () => {
    const box = await limitedBox("/missing-vitehub-cgroup");
    await expect(box.open()).rejects.toThrow(/cgroup/);
  });

  it("rejects invalid limits before opening", async () => {
    await expect(limitedBox("relative")).rejects.toThrow(/absolute delegated/);
    await expect(limitedBox("/sys/fs/cgroup", 0)).rejects.toThrow(/byte limit/);
    await expect(resolveBox({ runtime: {
      kind: "trusted-host", resources: { cgroupParent: "/sys/fs/cgroup", memoryMaxBytes: MiB, memoryHighBytes: 2 * MiB },
    } }, {})).rejects.toThrow(/must not exceed/);
  });

  it.skipIf(process.env.VITEHUB_TEST_DELEGATED_MEMORY !== "1")("starts a shell with its environment under a tight memory budget", async () => {
    const member = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))!.slice(3);
    const parent = dirname(join("/sys/fs/cgroup", member));
    const before = await readdir(parent);
    const box = await limitedBox(parent, 8 * MiB);
    const session = await box.open();
    try {
      const result = await session.exec("sh", ["-c", 'printf "%s" "$TOKEN"'], { env: { TOKEN: "tight budget" } });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("tight budget");
    } finally {
      await session.close();
    }
    expect((await readdir(parent)).sort()).toEqual(before.sort());
  }, 10_000);

  it.skipIf(process.env.VITEHUB_TEST_DELEGATED_MEMORY !== "1")("contains an OOM, keeps siblings alive, and reclaims groups", async () => {
    const member = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))!.slice(3);
    const parent = dirname(join("/sys/fs/cgroup", member));
    const before = await readdir(parent);
    const box = await limitedBox(parent);
    expect(box.plan.resources?.memoryMaxBytes).toBe(96 * MiB);
    await expect(box.open({ initialize: async () => { throw new Error("initialization failed"); } })).rejects.toThrow("initialization failed");
    expect((await readdir(parent)).sort()).toEqual(before.sort());
    const worker = await box.open();
    const sibling = await box.open();
    try {
      if (!sibling.spawn) throw new Error("trusted-host must support spawn");
      const alive = await sibling.spawn("sleep", ["30"]);
      // This descendant escapes the process group. Session cleanup must still reclaim it.
      await sibling.exec("sh", ["-c", "setsid sleep 30 >/dev/null 2>&1 & echo $!"]);
      if (!worker.spawn) throw new Error("trusted-host must support spawn");
      const held = await worker.spawn(process.execPath, ["-e", "const b=Buffer.alloc(48*1024**2, 1); process.stdout.write('ready'); setInterval(()=>b[0], 100)"]);
      const reader = held.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
      reader.releaseLock();
      // Each command fits alone. Their aggregate must exceed the session budget.
      await expect(worker.exec(process.execPath, ["-e", "const b=Buffer.alloc(48*1024**2, 1); setTimeout(()=>process.exit(b[0]-1), 150)"])).rejects.toThrow(/memory limit exceeded.*peak=/);
      await expect(held.wait()).rejects.toThrow(/memory limit exceeded/);
      await expect(worker.exec("true")).rejects.toThrow(/memory limit exceeded/);
      expect((await sibling.exec("kill", ["-0", String(alive.pid)])).code).toBe(0);
    } finally {
      await worker.close();
      await sibling.close();
    }
    expect((await readdir(parent)).sort()).toEqual(before.sort());
  }, 10_000);
});
