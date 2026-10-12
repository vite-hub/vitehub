import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { abortable } from "./abortable.ts";
import { isRuntimeNumber, isRuntimeString, runtimeRecord } from "./runtime-type.ts";

/**
 * Acquire a cross-process lock directory. A lock whose owner process is gone
 * on this host, or whose owner record stays unreadable, is treated as stale.
 */
export async function acquireFileLock(
  path: string,
  abortSignal?: AbortSignal,
): Promise<() => Promise<void>> {
  const token = randomUUID();
  while (true) {
    abortSignal?.throwIfAborted();
    const acquired = await mkdir(path, { mode: 0o700 }).then(
      () => true,
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const staleToken = await staleLock(path);
        if (staleToken) {
          const tombstone = `${path}.stale-${staleToken}`;
          await rename(path, tombstone).then(
            () => true,
            () => false,
          );
          // Keep the non-empty tombstone so another stale waiter cannot rename a
          // freshly acquired lock using the same observed owner token.
          return false;
        }
        return false;
      },
    );
    if (acquired) {
      try {
        await writeFile(
          join(path, "owner.json"),
          JSON.stringify({ host: hostname(), pid: process.pid, token }),
          { mode: 0o600 },
        );
      } catch (error) {
        await rm(path, { force: true, recursive: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        await rm(path, { force: true, recursive: true });
        released = true;
      };
    }
    await abortable(new Promise((resolvePromise) => setTimeout(resolvePromise, 25)), abortSignal);
  }
}

async function staleLock(path: string) {
  const owner = await readFile(join(path, "owner.json"), "utf8").then(
    (value) => {
      try {
        return runtimeRecord(JSON.parse(value));
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
  if (!owner) {
    const item = await stat(path).catch(() => undefined);
    return item && Date.now() - item.mtimeMs > 5_000
      ? `invalid-${item.dev}-${item.ino}-${Math.floor(item.mtimeMs)}`
      : undefined;
  }
  const { host, pid, token } = owner;
  if (host !== hostname() || !isRuntimeNumber(pid) || !isRuntimeString(token)) return undefined;
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH" ? token : undefined;
  }
}
