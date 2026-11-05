import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => ({
  createNodeModulesSnapshot: vi.fn(),
  packSnapshot: () => [new Uint8Array([1])],
  SnapshotLockfileMismatchError: class SnapshotLockfileMismatchError extends Error {},
}));
vi.mock("@vite-hub/web-container/snapshot", () => snapshot);

let dir: string;
let lockPath: string;
const lockfile = '{"packages":{}}\n';
const originalArgv = process.argv;
beforeEach(async () => {
  vi.resetModules();
  snapshot.createNodeModulesSnapshot.mockReset();
  dir = await mkdtemp(resolve(tmpdir(), "snapshot-worker-"));
  lockPath = resolve(dir, "package-lock.json");
  await mkdir(resolve(dir, "out"));
  await writeFile(lockPath, lockfile);
  process.argv = [process.execPath, "snapshot-worker.mjs", dir, resolve(dir, "out"), "tutorial", lockPath];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  await rm(dir, { recursive: true, force: true });
});

describe("tutorial snapshot lockfile retries", () => {
  it("propagates lockfile read errors before installing", async () => {
    await rm(lockPath);
    await mkdir(lockPath);
    await expect(import("../modules/tutorials/snapshot-worker.mjs")).rejects.toMatchObject({ code: "EISDIR" });
    expect(snapshot.createNodeModulesSnapshot).not.toHaveBeenCalled();
  });

  it("creates the first lockfile when none exists", async () => {
    await rm(lockPath);
    snapshot.createNodeModulesSnapshot.mockResolvedValueOnce({ snapshot: new Uint8Array([1]), lockfile: "created" });
    await import("../modules/tutorials/snapshot-worker.mjs");
    expect(snapshot.createNodeModulesSnapshot).toHaveBeenCalledExactlyOnceWith({ dir, lockfile: undefined });
    expect(await readFile(lockPath, "utf8")).toBe("created");
  });

  it.each(["registry unavailable", "permission denied while reading the tree"])("propagates %s without retrying or changing the lockfile", async (message) => {
    const error = new Error(message);
    snapshot.createNodeModulesSnapshot.mockRejectedValueOnce(error).mockResolvedValueOnce({ snapshot: new Uint8Array([1]), lockfile: "changed" });
    await expect(import("../modules/tutorials/snapshot-worker.mjs")).rejects.toBe(error);
    expect(snapshot.createNodeModulesSnapshot).toHaveBeenCalledExactlyOnceWith({ dir, lockfile });
    expect(await readFile(lockPath, "utf8")).toBe(lockfile);
    expect(await readdir(resolve(dir, "out"))).toEqual([]);
  });

  it("updates the lockfile only after a confirmed mismatch", async () => {
    snapshot.createNodeModulesSnapshot.mockRejectedValueOnce(new snapshot.SnapshotLockfileMismatchError("stale aliases"))
      .mockResolvedValueOnce({ snapshot: new Uint8Array([1]), lockfile: "updated" });
    await import("../modules/tutorials/snapshot-worker.mjs");
    expect(snapshot.createNodeModulesSnapshot).toHaveBeenNthCalledWith(2, { dir, lockfile, frozenLockfile: false });
    expect(await readFile(lockPath, "utf8")).toBe("updated");
  });
});
