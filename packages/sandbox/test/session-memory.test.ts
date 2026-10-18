import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandbox } from "../src/index.ts";

const MiB = 1024 ** 2;

async function limitedSandbox(cgroupParent: string, memoryMaxBytes = 96 * MiB) {
  return await resolveSandbox({ runtime: {
    kind: "trusted-host",
    resources: { cgroupParent, memoryMaxBytes, memorySwapMaxBytes: 0 },
  } }, {});
}

describe("trusted-host session memory", () => {
  it("fails closed when a delegated cgroup is unavailable", async () => {
    const sandbox = await limitedSandbox("/missing-vitehub-cgroup");
    await expect(sandbox.open()).rejects.toThrow(/cgroup/);
  });

  it("rejects invalid limits before opening", async () => {
    await expect(limitedSandbox("relative")).rejects.toThrow(/absolute delegated/);
    await expect(limitedSandbox("/sys/fs/cgroup", 0)).rejects.toThrow(/byte limit/);
    await expect(resolveSandbox({ runtime: {
      kind: "trusted-host", resources: { cgroupParent: "/sys/fs/cgroup", memoryMaxBytes: MiB, memoryHighBytes: 2 * MiB },
    } }, {})).rejects.toThrow(/must not exceed/);
  });

  it.skipIf(process.env.VITEHUB_TEST_DELEGATED_MEMORY !== "1")("starts a shell with its environment under a tight memory budget", async () => {
    const member = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))!.slice(3);
    const parent = dirname(join("/sys/fs/cgroup", member));
    const before = await readdir(parent);
    const sandbox = await limitedSandbox(parent, 8 * MiB);
    const session = await sandbox.open();
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
    const sandbox = await limitedSandbox(parent);
    expect(sandbox.plan.resources?.memoryMaxBytes).toBe(96 * MiB);
    await expect(sandbox.open({ initialize: async () => { throw new Error("initialization failed"); } })).rejects.toThrow("initialization failed");
    expect((await readdir(parent)).sort()).toEqual(before.sort());
    const worker = await sandbox.open();
    const sibling = await sandbox.open();
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
