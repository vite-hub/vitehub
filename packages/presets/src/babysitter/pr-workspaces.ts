import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

const exec = promisify(execFile);

/** Keep one workspace per open PR between passes. See `BabysitterOptions.warmWorkspaces`. */
export interface BabysitterWarmWorkspaces {
  /**
   * Continue the previous pass's provider thread when this pass starts in a warm workspace on the
   * same base commit and release, after a pass that pushed or recorded a wait. Defaults to `false`.
   */
  resumeThreads?: boolean;
  /** Disk the kept workspaces may use, in GiB. Least recently used entries go first. Defaults to 60. */
  budgetGb?: number;
  /** Days without a pass after which a PR's workspace is removed. Defaults to 7. */
  idleDays?: number;
  /** Free space, in percent of the filesystem, below which least recently used entries go. Defaults to 15. */
  minFreePercent?: number;
  /** Minutes between sweeps of terminal, idle and over-budget entries. `0` sweeps only at startup. Defaults to 60. */
  sweepMinutes?: number;
}

/** What a pass left in its PR workspace. The next pass decides from it whether to keep the tree. */
export interface PullRequestWorkspaceRecord {
  /** The head the workspace holds: the pass's push, or the head it started on. */
  head: string;
  /** The base commit the pass started on. */
  base?: string;
  /** The pass finished without an error, so its tree and installed dependencies are complete. */
  ok: boolean;
  /** The pass pushed or recorded a wait, so its provider thread may continue. */
  resumable?: boolean;
  release?: string;
  /** The provider thread suffix the pass ran in. */
  session?: string;
  outcome?: string;
}

interface StoredRecord extends PullRequestWorkspaceRecord {
  version: 1;
  repository: string;
  number: number;
  at: number;
  bytes?: number;
  bytesAt?: number;
}

export interface PullRequestWorkspaceEntry {
  /** The trusted host clone. */
  checkout: string;
  /** The provider workspace, used as `driver.cwd`. */
  work: string;
  /** Whether a provider workspace existed before this pass. */
  existed: boolean;
  previous?: PullRequestWorkspaceRecord;
  record(result: PullRequestWorkspaceRecord): Promise<void>;
  release(): Promise<void>;
}

export type PullRequestWorkspaceStatus = "open" | "terminal" | "unknown";

export interface PullRequestWorkspaces {
  root: string;
  resumeThreads: boolean;
  sweepMs: number;
  /** Locks the PR's entry for one pass. A pass that ends without `record()` leaves a failed record. */
  acquire(repository: string, number: number, signal?: AbortSignal): Promise<PullRequestWorkspaceEntry>;
  /** Removes terminal, unknown and idle entries, then least recently used ones while over budget or low on disk. */
  sweep(status: (repository: string, number: number) => Promise<PullRequestWorkspaceStatus>): Promise<{ removed: { name: string; reason: string }[]; keptBytes: number; kept: number }>;
}

const GiB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;

/** Validates `warmWorkspaces`. */
export function validWarmWorkspaces(value: unknown): value is boolean | BabysitterWarmWorkspaces {
  if (hasRuntimeType(value, "boolean")) return true;
  if (!isRuntimeRecord(value)) return false;
  const nonNegative = (key: string) => value[key] === undefined || (hasRuntimeType(value[key], "number") && Number.isFinite(value[key]) && value[key] >= 0);
  return Object.keys(value).every(key => ["resumeThreads", "budgetGb", "idleDays", "minFreePercent", "sweepMinutes"].includes(key))
    && (value.resumeThreads === undefined || hasRuntimeType(value.resumeThreads, "boolean"))
    && ["budgetGb", "idleDays", "minFreePercent", "sweepMinutes"].every(nonNegative)
    && (value.minFreePercent === undefined || (value.minFreePercent as number) <= 100);
}

/** `owner+name+number`: GitHub names never contain `+`, so an entry name maps back to one PR. */
function entryName(repository: string, number: number): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) {
    // Internal invariant: the inbox only claims PRs of configured owner/name repositories.
    throw new Error("Expected a GitHub repository in owner/name form and a pull request number.");
  }
  return `${repository.toLowerCase().replace("/", "+")}+${number}`;
}
const entryPattern = /^[\w.-]+\+[\w.-]+\+\d+$/;

/**
 * Whether a pass may keep the tree the previous pass left: only after a pass that finished, on the
 * head this pass starts from (its own push or an unchanged head). Preparation still resets a dirty tree.
 */
export function workspaceDecision(previous: PullRequestWorkspaceRecord | undefined, head: string, existed: boolean = previous !== undefined): { reuse: boolean; reason: string } {
  if (!previous) return { reuse: false, reason: existed ? "missing-metadata" : "cold" };
  if (previous.ok !== true) return { reuse: false, reason: "failed-pass" };
  if (previous.head !== head) return { reuse: false, reason: "foreign-head" };
  return { reuse: true, reason: "warm" };
}

/**
 * Whether a pass continues the previous pass's provider thread: only in a warm workspace, after a
 * pass that pushed or recorded a wait, on the same base commit and the same release.
 */
export function providerSessionDecision(previous: PullRequestWorkspaceRecord | undefined, workspace: string | undefined, current: { base?: string; release?: string }): { resume: boolean; reason: string } {
  if (workspace !== "warm") return { resume: false, reason: `workspace-${workspace ?? "unprepared"}` };
  if (previous?.resumable !== true || !previous.session) return { resume: false, reason: "unfinished-pass" };
  if (!current.base || previous.base !== current.base) return { resume: false, reason: "base-moved" };
  if (previous.release !== current.release) return { resume: false, reason: "new-release" };
  return { resume: true, reason: "resumed" };
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(directory: string): Promise<StoredRecord | undefined> {
  const record: unknown = await readFile(join(directory, "state.json"), "utf8").then(JSON.parse, () => undefined);
  return isRuntimeRecord(record) && hasRuntimeType(record.repository, "string") && Number.isSafeInteger(record.number) && hasRuntimeType(record.head, "string")
    // SAFETY: only writeRecord writes state.json, and the fields read above identify its shape.
    ? record as unknown as StoredRecord : undefined;
}

async function writeRecord(directory: string, record: StoredRecord): Promise<void> {
  const path = join(directory, "state.json");
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(record));
  await rename(temporary, path);
}

/** Disk use of a directory, counting hard-linked files once, on its own filesystem. */
async function diskUsage(directory: string): Promise<number> {
  const { stdout } = await exec("du", ["-sk", "--one-file-system", "--", directory], { maxBuffer: 1024 * 1024 });
  return Number(stdout.split(/\s/)[0]) * 1024;
}

/**
 * One persistent workspace per open PR under `root`. Each entry holds the trusted host clone
 * (`checkout/`), the provider workspace (`work/`), `state.json` with what the last pass left, and a
 * `lock` file with the owning process ID.
 */
export function createPullRequestWorkspaces(options: { root: string; now?: () => number } & BabysitterWarmWorkspaces): PullRequestWorkspaces {
  const root = resolve(options.root);
  const now = options.now ?? Date.now;
  const budgetBytes = (options.budgetGb ?? 60) * GiB;
  const idleMs = (options.idleDays ?? 7) * DAY;
  const minFreeRatio = (options.minFreePercent ?? 15) / 100;
  const mutexes = new Map<string, Promise<void>>();
  const held = new Set<string>();
  let sweeping: ReturnType<PullRequestWorkspaces["sweep"]> | undefined;

  const lockMutex = async (name: string) => {
    const previous = mutexes.get(name) ?? Promise.resolve();
    let unlock!: () => void;
    const next = new Promise<void>(resolve => unlock = resolve);
    const chained = previous.then(() => next);
    mutexes.set(name, chained);
    await previous;
    return () => {
      unlock();
      if (mutexes.get(name) === chained) mutexes.delete(name);
    };
  };
  /** Takes the entry's lock file. A lock whose process is gone is stale. */
  const tryLockFile = async (name: string) => {
    const path = join(root, name, "lock");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mkdir(join(root, name), { recursive: true });
        const handle = await open(path, "wx");
        try { await handle.writeFile(String(process.pid)); }
        finally { await handle.close(); }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = await readFile(path, "utf8").catch(() => undefined);
      if (owner === undefined) continue;
      const info = await lstat(path).catch(() => undefined);
      // An empty lock belongs to a process between open and write; it is stale only when old.
      const stale = owner === "" ? !info || now() - info.mtimeMs > 60_000 : !alive(Number(owner)) || (Number(owner) === process.pid && !held.has(name));
      if (!stale) return false;
      await rm(path, { force: true });
    }
    return false;
  };
  const releaser = (name: string, unlock: () => void) => async (removed = false) => {
    held.delete(name);
    try {
      const path = join(root, name, "lock");
      if (!removed && await readFile(path, "utf8").catch(() => undefined) === String(process.pid)) await rm(path, { force: true });
    } finally {
      unlock();
    }
  };
  const lock = async (name: string, signal?: AbortSignal) => {
    const unlock = await lockMutex(name);
    try {
      while (!await tryLockFile(name)) {
        signal?.throwIfAborted();
        await sleep(500, undefined, { signal });
      }
    } catch (error) {
      unlock();
      throw error;
    }
    held.add(name);
    return releaser(name, unlock);
  };
  /** Takes the entry only when no pass holds it. */
  const tryLock = async (name: string) => {
    if (held.has(name) || mutexes.has(name)) return undefined;
    const unlock = await lockMutex(name);
    if (!await tryLockFile(name).catch(() => false)) {
      unlock();
      return undefined;
    }
    held.add(name);
    return releaser(name, unlock);
  };
  /** Moves a locked entry out of the pool in one rename, then deletes it. */
  const removeLocked = async (name: string) => {
    const directory = join(root, name);
    if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) return false;
    const trash = join(root, `.trash-${name}-${randomUUID()}`);
    await rename(directory, trash);
    await rm(trash, { recursive: true, force: true, maxRetries: 3 });
    return true;
  };

  return {
    root,
    resumeThreads: options.resumeThreads === true,
    sweepMs: (options.sweepMinutes ?? 60) * 60_000,
    async acquire(repository, number, signal) {
      const name = entryName(repository, number);
      const directory = join(root, name);
      const release = await lock(name, signal);
      try {
        const checkout = join(directory, "checkout");
        const work = join(directory, "work");
        const existed = Boolean((await lstat(work).catch(() => undefined))?.isDirectory());
        const stored = await readRecord(directory);
        const previous = stored && stored.repository.toLowerCase() === repository.toLowerCase() && stored.number === number ? stored : undefined;
        // The pass may leave the tree half-written. Until it records its result, a crash or kill must
        // leave a failed record behind, so the next pass resets the tree.
        if (previous) await writeRecord(directory, { ...previous, ok: false, resumable: false });
        await mkdir(checkout, { recursive: true });
        await mkdir(work, { recursive: true });
        let released = false;
        return {
          checkout,
          work,
          existed,
          previous: previous && { head: previous.head, base: previous.base, ok: previous.ok, resumable: previous.resumable, release: previous.release, session: previous.session, outcome: previous.outcome },
          async record(result) {
            await writeRecord(directory, { ...result, version: 1, repository, number, at: now() });
          },
          async release() {
            if (released) return;
            released = true;
            await release();
          },
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
    async sweep(status) {
      sweeping ??= (async () => {
        const removed: { name: string; reason: string }[] = [];
        const kept: { name: string; bytes: number; usedAt: number }[] = [];
        const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".trash-")) {
            await rm(join(root, entry.name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
            continue;
          }
          if (!entryPattern.test(entry.name)) continue;
          const directory = join(root, entry.name);
          const release = await tryLock(entry.name);
          if (!release) continue;
          let gone = false;
          try {
            const record = await readRecord(directory);
            const state = record ? await status(record.repository, record.number) : "unknown";
            const usedAt = record?.at ?? (await lstat(directory)).mtimeMs;
            const reason = state === "terminal" ? "terminal" : state === "unknown" ? "unknown" : now() - usedAt > idleMs ? "idle" : undefined;
            if (reason || !record) {
              gone = await removeLocked(entry.name);
              if (gone) removed.push({ name: entry.name, reason: reason ?? "unknown" });
              continue;
            }
            let bytes = record.bytes;
            if (bytes === undefined || !Number.isFinite(bytes) || (record.bytesAt ?? 0) < record.at) {
              bytes = await diskUsage(directory);
              await writeRecord(directory, { ...record, bytes, bytesAt: now() });
            }
            kept.push({ name: entry.name, bytes, usedAt });
          } finally {
            await release(gone);
          }
        }
        let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
        let evicted = 0;
        for (const entry of kept.sort((left, right) => left.usedAt - right.usedAt)) {
          const lowDisk = await statfs(root).then(info => info.blocks > 0 && info.bavail / info.blocks < minFreeRatio, () => false);
          if (total <= budgetBytes && !lowDisk) break;
          const release = await tryLock(entry.name);
          if (!release) continue;
          let gone = false;
          try { gone = await removeLocked(entry.name); }
          finally { await release(gone); }
          if (!gone) continue;
          total -= entry.bytes;
          evicted++;
          removed.push({ name: entry.name, reason: lowDisk ? "low-disk" : "budget" });
        }
        return { removed, keptBytes: total, kept: kept.length - evicted };
      })().finally(() => { sweeping = undefined; });
      return await sweeping;
    },
  };
}
