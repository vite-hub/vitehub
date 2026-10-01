import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import * as v from "valibot";

import { hubConnectionsTypesCleanup } from "../src/vite.ts";

import type { ChildProcess } from "node:child_process";

function waitForMessage(child: ChildProcess, expected: string): Promise<{ phase: string; acquired?: boolean }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      const parsed = v.safeParse(v.object({ phase: v.string(), acquired: v.optional(v.boolean()) }), message);
      if (parsed.success && parsed.output.phase === expected) {
        child.off("message", onMessage);
        child.off("error", reject);
        child.off("exit", onExit);
        resolve(parsed.output);
      }
    };
    const onExit = (code: number | null) => reject(new Error(`Lock test child exited before ${expected}: ${code}`));
    child.on("message", onMessage);
    child.once("error", reject);
    child.once("exit", onExit);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

it("keeps a newly acquired live lock when a second stale waiter resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-lock-race-"));
  const directory = join(root, ".vitehub/connections-types.json.lock");
  const oldOwner = `owner-${randomUUID()}.json`;
  const oldGuard = join(directory, oldOwner);
  const firstDeclaration = join(root, "api-a/.vitehub/types/connections.d.ts");
  const script = join(root, "worker.mjs");
  await writeFile(script, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const role = process.argv[2];
    const originalUnlink = fs.unlink;
    const originalRename = fs.rename;
    const originalWrite = fs.writeFile;
    let allowReap;
    let allowWrite;
    let reaped = false;
    const reapGate = new Promise(resolve => { allowReap = resolve; });
    const writeGate = new Promise(resolve => { allowWrite = resolve; });
    fs.unlink = async path => {
      if (String(path) !== ${JSON.stringify(oldGuard)}) return await originalUnlink(path);
      process.send({ phase: "observed" });
      await reapGate;
      try { return await originalUnlink(path); }
      finally { reaped = true; }
    };
    fs.rename = async (from, to) => {
      try {
        const result = await originalRename(from, to);
        if (role === "second" && reaped && String(to) === ${JSON.stringify(directory)}) process.send({ phase: "replacement-attempt", acquired: true });
        return result;
      } catch (error) {
        if (role === "second" && reaped && String(to) === ${JSON.stringify(directory)}) process.send({ phase: "replacement-attempt", acquired: false });
        throw error;
      }
    };
    fs.writeFile = async (...args) => {
      if (role === "first" && String(args[0]) === ${JSON.stringify(firstDeclaration)}) {
        process.send({ phase: "acquired" });
        await writeGate;
      }
      return await originalWrite(...args);
    };
    syncBuiltinESMExports();
    const module = import(${JSON.stringify(process.env.VITEHUB_CONNECTIONS_TYPES_LOCK_TEST_MODULE ?? new URL("../dist/vite.js", import.meta.url).href)});
    process.on("message", async message => {
      if (message === "exit") process.exit(0);
      if (message === "reap") return allowReap();
      if (message === "write") return allowWrite();
      const { hubConnections } = await module;
      await hubConnections({ projectRoot: message }).api.prepareTypes({ projectRoot: ${JSON.stringify(root)} });
      process.send({ phase: "prepared" });
    });
    process.send({ phase: "started" });
  `);
  const children: ChildProcess[] = [];
  const createChild = (role: string) => {
    const child = fork(script, [role], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    return child;
  };
  try {
    const former = createChild("former");
    await waitForMessage(former, "started");
    const formerExit = new Promise<void>(resolve => former.once("exit", () => resolve()));
    former.send("exit");
    await formerExit;
    await mkdir(directory, { recursive: true });
    await writeFile(oldGuard, JSON.stringify({ pid: former.pid }));

    const first = createChild("first");
    const second = createChild("second");
    await Promise.all([waitForMessage(first, "started"), waitForMessage(second, "started")]);
    const observed = Promise.all([waitForMessage(first, "observed"), waitForMessage(second, "observed")]);
    first.send("api-a");
    second.send("api-b");
    await observed;
    const acquired = waitForMessage(first, "acquired");
    first.send("reap");
    await acquired;
    const replacementAttempt = waitForMessage(second, "replacement-attempt");
    second.send("reap");
    expect(await replacementAttempt).toMatchObject({ acquired: false });
    const guards = await readdir(directory);
    expect(guards).toHaveLength(1);
    expect(guards[0]).not.toBe(oldOwner);
    expect(JSON.parse(await readFile(join(directory, guards[0]!), "utf8"))).toMatchObject({ pid: first.pid });

    const prepared = Promise.all([waitForMessage(first, "prepared"), waitForMessage(second, "prepared")]);
    first.send("write");
    await prepared;
    await Promise.all(children.map(stop));
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    for (const name of ["api-a", "api-b"]) {
      await expect(readFile(join(root, name, ".vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await Promise.all(children.map(stop));
    await rm(root, { force: true, recursive: true });
  }
});

it("reclaims a dead owner's lock when its recorded PID belongs to another live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-reused-pid-"));
  const directory = join(root, ".vitehub/connections-types.json.lock");
  const script = join(root, "owner.mjs");
  await writeFile(script, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const originalWrite = fs.writeFile;
    fs.writeFile = async (...args) => {
      if (String(args[0]) === ${JSON.stringify(join(root, "api/.vitehub/types/connections.d.ts"))}) {
        process.send({ phase: "acquired" });
        await new Promise(() => {});
      }
      return await originalWrite(...args);
    };
    syncBuiltinESMExports();
    const { hubConnections } = await import(${JSON.stringify(new URL("../dist/vite.js", import.meta.url).href)});
    await hubConnections({ projectRoot: "api" }).api.prepareTypes({ projectRoot: ${JSON.stringify(root)} });
  `);
  const original = fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    await waitForMessage(original, "acquired");
    const guards = await readdir(directory);
    expect(guards).toHaveLength(1);
    const guard = join(directory, guards[0]!);
    const owner = JSON.parse(await readFile(guard, "utf8")) as { pid: number; ipc: boolean; host: string };
    expect(owner.ipc).toBe(true);
    expect(owner.pid).toBe(original.pid);
    await stop(original);
    // Simulate OS PID reuse with an unrelated process that remains alive throughout recovery.
    await writeFile(guard, JSON.stringify({ ...owner, pid: process.pid }));
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    const { hubConnections } = await import("../src/vite.ts");
    await hubConnections({ projectRoot: "api" }).api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, "api/.vitehub/types/connections.d.ts"), "utf8")).resolves.toBeTruthy();
    await hubConnectionsTypesCleanup().api!.prepareTypes({ projectRoot: root });
    await expect(readFile(join(root, "api/.vitehub/types/connections.d.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await stop(original);
    await rm(root, { force: true, recursive: true });
  }
});
