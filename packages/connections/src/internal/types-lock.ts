import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { hostname, tmpdir } from "node:os";

import * as v from "valibot";

const ownerSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ipc: v.optional(v.literal(true)),
  host: v.optional(v.string()),
});
const ownerFilePattern = /^owner-[a-f0-9-]{36}\.json$/;
const abandonedEmptyLockMs = 30_000;
const acquisitionTimeoutMs = 10_000;

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

function ownerEndpoint(token: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\vitehub-connections-${token}`;
  if (process.platform === "linux") return `\0vitehub-connections-${token}`;
  return resolve(tmpdir(), `vhc-${token}`);
}

async function openOwnerEndpoint(token: string) {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ownerEndpoint(token), () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  return server;
}

async function endpointOwnerIsActive(token: string): Promise<boolean | undefined> {
  return await new Promise(resolve => {
    const socket = createConnection(ownerEndpoint(token));
    const timeout = setTimeout(() => finish(undefined), 500);
    const finish = (active: boolean | undefined) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(active);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", error => finish(hasCode(error, "ENOENT", "ECONNREFUSED") ? false : undefined));
  });
}

async function removeEndpoint(token: string): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "linux") await rm(ownerEndpoint(token), { force: true });
}

async function removeOwnedDirectory(directory: string, ownerFile: string): Promise<boolean> {
  try {
    // A replacement lock has a different guard filename. Never remove its guard.
    await unlink(resolve(directory, ownerFile));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    // New owners publish nonempty directories, so rmdir cannot remove a replacement.
    await rmdir(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
  }
  return true;
}

async function recoverAbandonedDirectory(directory: string): Promise<boolean> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  if (files.length === 0) {
    // Earlier versions could leave an empty lock. Current owners never publish one.
    try {
      if (Date.now() - (await lstat(directory)).mtimeMs <= abandonedEmptyLockMs) return false;
      await rmdir(directory);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      if (hasCode(error, "ENOTEMPTY", "EEXIST")) return false;
      throw error;
    }
  }
  if (files.length !== 1 || !ownerFilePattern.test(files[0]!)) return false;
  const ownerFile = files[0]!;
  let input: unknown;
  try {
    input = JSON.parse(await readFile(resolve(directory, ownerFile), "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const owner = v.safeParse(ownerSchema, input);
  if (!owner.success) return false;
  if (owner.output.ipc) {
    if (owner.output.host !== hostname()) return false;
    const token = ownerFile.slice("owner-".length, -".json".length);
    // The unique endpoint identifies the original process even after its PID is reused.
    if (await endpointOwnerIsActive(token) !== false) return false;
    const removed = await removeOwnedDirectory(directory, ownerFile);
    if (removed) await removeEndpoint(token);
    return removed;
  }
  try {
    process.kill(owner.output.pid, 0);
    return false;
  } catch (error) {
    // PID reuse and permission failures retain the lock. Only a confirmed exit permits recovery.
    if (!hasCode(error, "ESRCH")) return false;
  }
  return await removeOwnedDirectory(directory, ownerFile);
}

/** Serialize generated output with a nonempty, uniquely owned directory lock. */
export async function withConnectionsTypesLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(directory), { recursive: true });
  const token = randomUUID();
  const candidate = `${directory}.${token}.tmp`;
  const ownerFile = `owner-${token}.json`;
  await mkdir(candidate);
  let endpoint: Awaited<ReturnType<typeof openOwnerEndpoint>> | undefined;
  let acquired = false;
  try {
    endpoint = await openOwnerEndpoint(token);
    await writeFile(resolve(candidate, ownerFile), JSON.stringify({ pid: process.pid, ipc: true, host: hostname() }));
    const deadline = Date.now() + acquisitionTimeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out acquiring the Connections type generation lock ${JSON.stringify(directory)}.`), { code: "ELOCKED" });
      try {
        // Atomic publication makes the guard visible with the lock, without an empty-owner gap.
        await rename(candidate, directory);
        acquired = true;
        break;
      } catch (error) {
        const existing = await lstat(directory).catch(cause => {
          if (hasCode(cause, "ENOENT")) return undefined;
          throw cause;
        });
        if (!existing) continue;
        if (!existing.isDirectory()) throw error;
        if (await recoverAbandonedDirectory(directory)) continue;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now())));
      }
    }
    return await action();
  } finally {
    try {
      if (acquired) await removeOwnedDirectory(directory, ownerFile);
    } finally {
      try {
        if (endpoint) await new Promise<void>((resolve, reject) => endpoint!.close(error => error ? reject(error) : resolve()));
      } finally {
        await rm(candidate, { force: true, recursive: true });
      }
    }
  }
}
