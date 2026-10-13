import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, constants, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineDiagnostics } from "nostics";

export interface TrustedHostResources {
  /** Writable delegated cgroup v2 parent. The controller must live in a separate subgroup. */
  cgroupParent: string;
  /** Aggregate resident memory limit for this session's commands and descendants. */
  memoryMaxBytes: number;
  memoryHighBytes?: number;
  /** Aggregate swap limit. Defaults to zero. */
  memorySwapMaxBytes?: number;
}

const diagnostics = defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    BOX_R0157: { why: ({ message }: { message: string }) => message },
    BOX_R0158: { why: ({ message }: { message: string }) => message },
  },
});

export function validateTrustedHostResources(resources: TrustedHostResources): void {
  if (process.platform !== "linux" || !isAbsolute(resources.cgroupParent)) {
    throw diagnostics.BOX_R0157({ message: "Box memory limits require Linux and an absolute delegated cgroupParent." });
  }
  for (const [key, value] of Object.entries({
    memoryMaxBytes: resources.memoryMaxBytes,
    memoryHighBytes: resources.memoryHighBytes ?? resources.memoryMaxBytes,
    memorySwapMaxBytes: resources.memorySwapMaxBytes ?? 0,
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || (key !== "memorySwapMaxBytes" && value === 0)) {
      throw diagnostics.BOX_R0157({ message: `Box ${key} must be a safe integer byte limit.` });
    }
  }
  if ((resources.memoryHighBytes ?? resources.memoryMaxBytes) > resources.memoryMaxBytes) {
    throw diagnostics.BOX_R0157({ message: "Box memoryHighBytes must not exceed memoryMaxBytes." });
  }
}

export interface SessionMemory {
  assertHealthy(): Promise<void>;
  spawn(command: string, options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export async function createSessionMemory(resources: TrustedHostResources): Promise<SessionMemory> {
  validateTrustedHostResources(resources);
  const parent = resources.cgroupParent;
  // Never silently create ordinary files in a directory that is not a cgroup mount.
  if ((await statfs(parent)).type !== 0x63677270) {
    throw diagnostics.BOX_R0157({ message: "Box cgroupParent must be on a cgroup v2 filesystem." });
  }
  const controllers = (await readFile(join(parent, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
  if (!controllers.includes("memory")) {
    throw diagnostics.BOX_R0157({ message: "Box cgroupParent does not delegate the memory controller." });
  }
  await writeFile(join(parent, "cgroup.subtree_control"), "+memory");
  const path = join(parent, `vitehub-box-${randomUUID()}`);
  await mkdir(path);
  try {
    await writeFile(join(path, "memory.max"), String(resources.memoryMaxBytes));
    if (resources.memoryHighBytes !== undefined) await writeFile(join(path, "memory.high"), String(resources.memoryHighBytes));
    await writeFile(join(path, "memory.swap.max"), String(resources.memorySwapMaxBytes ?? 0));
    // Kill the whole worker, including its compiler and provider, on a local OOM.
    await writeFile(join(path, "memory.oom.group"), "1");
    await access(join(path, "cgroup.procs"), constants.W_OK);
    await access(join(path, "cgroup.kill"), constants.W_OK);
  } catch (error) {
    await rmdir(path);
    throw error;
  }
  let closed = false;
  let healthError: Error | undefined;
  // cgroupfs only accepts kernel-defined interface files. Keep the launcher
  // fence in a private filesystem path instead of the virtual cgroup directory.
  const healthMarker = join(tmpdir(), `vitehub-box-oom-${randomUUID()}`);
  const inspectHealth = async (): Promise<void> => {
    if (closed || healthError) return;
    const localEvents = await readFile(join(path, "memory.events.local"), "utf8");
    const localOom = Number(/^oom (\d+)/m.exec(localEvents)?.[1] ?? 0);
    if (localOom > 0) {
      const events = await readFile(join(path, "memory.events"), "utf8");
      const kills = Number(/^oom_kill (\d+)/m.exec(events)?.[1] ?? 0);
      const peak = await readFile(join(path, "memory.peak"), "utf8")
        .then(contents => contents.trim())
        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "unavailable" : Promise.reject(error));
      healthError = diagnostics.BOX_R0158({ message: `Box memory limit exceeded: local allocation OOM recorded; limit=${resources.memoryMaxBytes} bytes, peak=${peak} bytes, local_oom=${localOom}, observed_oom_kill=${kills}. Kill count does not identify the OOM cause and may exclude descendants on memory_localevents mounts. Open a new session after reducing the workload or changing its budget.` });
      const cleanupErrors: unknown[] = [];
      try {
        await writeFile(healthMarker, "1");
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        // Always terminate the group, even when the private fence cannot be written.
        await writeFile(join(path, "cgroup.kill"), "1");
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        healthError.message += ` Cleanup details: ${cleanupErrors.map(error => error instanceof Error ? error.message : String(error)).join("; ")}.`;
      }
    }
  };
  const monitor = setInterval(() => {
    void inspectHealth().catch(error => {
      // Once a local allocation OOM is observed, retain BOX_R0158 even if
      // optional fencing or cgroup termination writes fail.
      if (!healthError) healthError = error instanceof Error ? error : new Error(String(error));
    });
  }, 25);
  monitor.unref?.();
  return {
    async assertHealthy() {
      if (closed) throw diagnostics.BOX_R0157({ message: "Box resource group is closed." });
      await inspectHealth();
      if (healthError) throw healthError;
    },
    spawn(command: string, options: SpawnOptionsWithoutStdio) {
      // Join the cgroup before starting the command. Startup hooks are restored only
      // after that move, so caller-controlled loaders cannot fork outside the limit.
      const environment = Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
      const environmentFile = join(tmpdir(), `vitehub-box-env-${randomUUID()}`);
      try {
        // Prepare the trusted helper under the controller budget. Linux keeps
        // existing memory charges there on migration, so Node startup does not
        // consume the session's tight budget. Admission and exec happen below.
        // No caller environment (including loader hooks) is installed until exec.
        writeFileSync(environmentFile, JSON.stringify(Object.fromEntries(environment)), { mode: 0o600 });
        chmodSync(environmentFile, 0o600);
        const child = spawn(process.execPath, [
          "--input-type=commonjs", "-e",
          `const fs = require("node:fs");
const [group, marker, environmentFile, command] = process.argv.slice(1);
const env = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
const args = ["/bin/sh", "-c", command];
fs.writeFileSync(group + "/cgroup.procs", String(process.pid));
if (fs.existsSync(marker) || !/^oom 0$/m.test(fs.readFileSync(group + "/memory.events.local", "utf8"))) process.exit(125);
process.execve("/bin/sh", args, env);`,
          path, healthMarker, environmentFile, command,
        ], { ...options, env: {} });
        child?.once("close", () => {
          try {
            rmSync(environmentFile, { force: true });
          } catch {
            // Cleanup must not interrupt command completion or process tracking.
          }
        });
        return child;
      } catch (error) {
        try {
          rmSync(environmentFile, { force: true });
        } catch {
          // Preserve the setup failure if best-effort secret-file cleanup fails.
        }
        throw error;
      }
    },
    async kill() {
      if (!closed) await writeFile(join(path, "cgroup.kill"), "1");
    },
    async close() {
      if (closed) return;
      clearInterval(monitor);
      await writeFile(join(path, "cgroup.kill"), "1");
      // Wait for all descendants to exit before removing nested cgroups.
      await waitForCgroupEmpty(path);
      await removeDescendantCgroups(path);
      await rmdir(path);
      await rm(healthMarker, { force: true }).catch(() => undefined);
      closed = true;
    },
  };
}

async function waitForCgroupEmpty(path: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (true) {
    const events = await readFile(join(path, "cgroup.events"), "utf8");
    const populated = /^populated (\d+)/m.exec(events)?.[1];
    if (populated === undefined || populated === "0") return;
    if (performance.now() >= deadline) {
      throw diagnostics.BOX_R0157({ message: `Timed out waiting for Box cgroup ${path} to become empty; it remains populated. Retry session close after its descendants exit.` });
    }
    await delay(25);
  }
}

async function removeDescendantCgroups(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(path, entry.name);
    await removeDescendantCgroups(child);
    await rmdir(child);
  }
}
