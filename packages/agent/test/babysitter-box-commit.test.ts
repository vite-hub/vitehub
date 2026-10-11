import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBox } from "@vite-hub/box";
import { importBoxCommit } from "../src/presets/babysitter/box-commit.ts";
import { commitGitHubPullRequestWorkspace } from "../src/server/github-repair.ts";
import { importBoxRepairFiles, importBoxRepairWorkspace, publishBoxDependencies } from "../src/presets/babysitter/box-repair.ts";
import { createProviderHeadReader } from "../src/presets/babysitter/checkout-watch.ts";
import { chmod, lstat, mkdir, symlink } from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args])).stdout.trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "babysitter-box-commit-"));
  roots.push(root);
  const checkout = join(root, "host");
  const remote = join(root, "box");
  await git(root, "init", checkout);
  await writeFile(join(checkout, "source.txt"), "original\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");
  const base = await git(checkout, "rev-parse", "HEAD");
  await git(root, "clone", checkout, remote);
  const session = await (await resolveBox({ runtime: "trusted-host", cwd: remote }, {})).open();
  return { checkout, remote, base, session, signal: new AbortController().signal };
}

it("transfers binary files, executable files, symlinks and deletions without changing host Git metadata", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "binary.bin"), new Uint8Array([0, 255, 10]));
    await writeFile(join(f.remote, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(f.remote, "run.sh"), 0o755);
    await symlink("binary.bin", join(f.remote, "link"));
    await rm(join(f.remote, "source.txt"));
    await importBoxRepairFiles(f.session, f.checkout, ["binary.bin", "run.sh", "link", "source.txt"], f.signal);
    expect(await readFile(join(f.checkout, "binary.bin"))).toEqual(Buffer.from([0, 255, 10]));
    expect((await lstat(join(f.checkout, "run.sh"))).mode & 0o111).toBe(0o111);
    expect((await lstat(join(f.checkout, "link"))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(f.checkout, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
  } finally { await f.session.close(); }
});

it("removes a previously imported untracked dependency file on the next Box refresh", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "package.json"), JSON.stringify({ name: "temporary-dependency" }));
    await importBoxRepairWorkspace(f.session, f.checkout, f.signal);
    expect(await readFile(join(f.checkout, "package.json"), "utf8")).toContain("temporary-dependency");
    await rm(join(f.remote, "package.json"));
    await importBoxRepairWorkspace(f.session, f.checkout, f.signal);
    await expect(lstat(join(f.checkout, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
  } finally { await f.session.close(); }
});

it("reads a successive provider push from Git before its receipt replaces the first push", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.checkout, "source.txt"), "first repair\n");
    await git(f.checkout, "commit", "-am", "first repair");
    const firstHead = await git(f.checkout, "rev-parse", "HEAD");
    const readHead = createProviderHeadReader(() => f.checkout, () => firstHead);
    expect(await readHead()).toBe(firstHead);
    await writeFile(join(f.checkout, "source.txt"), "second repair\n");
    await git(f.checkout, "commit", "-am", "second repair");
    expect(await readHead()).toBe(await git(f.checkout, "rev-parse", "HEAD"));
    expect(await createProviderHeadReader(() => undefined, () => firstHead)()).toBe(firstHead);
    await expect(createProviderHeadReader(() => join(f.checkout, "missing"), () => firstHead)()).rejects.toThrow();
  } finally { await f.session.close(); }
});

it("rejects host metadata paths and symlinked destination parents before copying Box edits", async () => {
  const f = await fixture();
  try {
    await symlink(".git", join(f.checkout, "metadata"));
    await expect(importBoxRepairFiles(f.session, f.checkout, [".git/config"], f.signal)).rejects.toThrow("inside the assigned checkout");
    await expect(importBoxRepairFiles(f.session, f.checkout, ["metadata/config"], f.signal)).rejects.toThrow("parent must stay inside");
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
  } finally { await f.session.close(); }
});

it("publishes dependencies into the active Box and removes obsolete root outputs", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.checkout, "node_modules", "example"), { recursive: true });
    await writeFile(join(f.checkout, "node_modules", "example", "index.js"), "export const ready = true\n");
    await writeFile(join(f.remote, ".pnp.cjs"), "old PnP output\n");
    await publishBoxDependencies(f.session, f.checkout, f.signal);
    expect(await readFile(join(f.remote, "node_modules", "example", "index.js"), "utf8")).toContain("ready = true");
    await expect(lstat(join(f.remote, ".pnp.cjs"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.session.close(); }
});

it("imports a remote repair commit before the Box closes, including a second push", async () => {
  const f = await fixture();
  try {
    for (const contents of ["first repair\n", "second repair\n"]) {
      await writeFile(join(f.remote, "source.txt"), contents);
      await git(f.remote, "commit", "-am", "repair");
      const head = await git(f.remote, "rev-parse", "HEAD");
      expect(await git(f.checkout, "rev-parse", "HEAD")).not.toBe(head);
      await importBoxCommit(f.session, f.checkout, f.base, f.signal);
      expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(head);
      expect(await git(f.checkout, "show", "HEAD:source.txt")).toBe(contents.trim());
      expect(await readFile(join(f.checkout, "source.txt"), "utf8")).toBe(contents);
    }
  } finally { await f.session.close(); }
});

it("commits an uncommitted Box edit after importing a different committed repair", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "committed Box repair\n");
    await git(f.remote, "commit", "-am", "Box repair");
    const boxHead = await git(f.remote, "rev-parse", "HEAD");
    await writeFile(join(f.remote, "follow-up.txt"), "uncommitted Box follow-up\n");
    await writeFile(join(f.checkout, "local-note.txt"), "keep unrelated host file\n");
    await importBoxCommit(f.session, f.checkout, f.base, f.signal);
    await importBoxRepairFiles(f.session, f.checkout, ["follow-up.txt"], f.signal);
    const repaired = await commitGitHubPullRequestWorkspace(f.checkout, { message: "Follow-up", paths: ["follow-up.txt"] }, { expectedHead: f.base, signal: f.signal });
    expect(await git(f.checkout, "rev-parse", `${repaired}^`)).toBe(boxHead);
    expect(await git(f.checkout, "show", "HEAD:source.txt")).toBe("committed Box repair");
    expect(await git(f.checkout, "show", "HEAD:follow-up.txt")).toBe("uncommitted Box follow-up");
    expect(await git(f.checkout, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(f.checkout, "local-note.txt"), "utf8")).toBe("keep unrelated host file\n");
  } finally { await f.session.close(); }
});

it("leaves the host HEAD unchanged when bundle transfer fails", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "repair\n");
    await git(f.remote, "commit", "-am", "repair");
    const read = vi.spyOn(f.session.files, "read").mockRejectedValueOnce(new Error("transfer failed"));
    await expect(importBoxCommit(f.session, f.checkout, f.base, f.signal)).rejects.toThrow("transfer failed");
    expect(read).toHaveBeenCalled();
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
    expect(await git(f.remote, "status", "--porcelain")).toBe("");
  } finally { await f.session.close(); }
});

it("retains a host repair that already contains the imported Box commit", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "Box repair\n");
    await git(f.remote, "commit", "-am", "Box repair");
    await importBoxCommit(f.session, f.checkout, f.base, f.signal);
    await writeFile(join(f.checkout, "source.txt"), "host follow-up\n");
    await git(f.checkout, "commit", "-am", "host follow-up");
    const latest = await git(f.checkout, "rev-parse", "HEAD");
    await importBoxCommit(f.session, f.checkout, f.base, f.signal);
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(latest);
  } finally { await f.session.close(); }
});

it("rejects a divergent Box commit instead of replacing an existing host repair", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "Box repair\n");
    await git(f.remote, "commit", "-am", "Box repair");
    await writeFile(join(f.checkout, "source.txt"), "host repair\n");
    await git(f.checkout, "commit", "-am", "host repair");
    const latest = await git(f.checkout, "rev-parse", "HEAD");
    await expect(importBoxCommit(f.session, f.checkout, f.base, f.signal)).rejects.toThrow();
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(latest);
  } finally { await f.session.close(); }
});

it("rejects a repair that does not descend from the prepared HEAD", async () => {
  const f = await fixture();
  try {
    await git(f.remote, "checkout", "--orphan", "unrelated");
    await git(f.remote, "commit", "-m", "unrelated");
    await expect(importBoxCommit(f.session, f.checkout, f.base, f.signal)).rejects.toThrow("Cannot export");
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
  } finally { await f.session.close(); }
});

it.each([
  { transferFails: false, localCleanupFails: false },
  { transferFails: false, localCleanupFails: true },
  { transferFails: true, localCleanupFails: false },
  { transferFails: true, localCleanupFails: true },
])("preserves the import result when cleanup fails ($transferFails, $localCleanupFails)", async ({ transferFails, localCleanupFails }) => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "repair\n");
    await git(f.remote, "commit", "-am", "repair");
    const head = await git(f.remote, "rev-parse", "HEAD");
    const failure = new Error("transfer failed");
    if (transferFails) vi.spyOn(f.session.files, "read").mockRejectedValueOnce(failure);
    // Remove the real directory before simulating a filesystem cleanup rejection.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    if (localCleanupFails) vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      await actual.rm(path, options);
      throw new Error("local cleanup failed");
    });
    const remove = vi.spyOn(f.session.files, "remove").mockRejectedValueOnce(new Error("remote cleanup failed"));
    const result = importBoxCommit(f.session, f.checkout, f.base, f.signal);
    if (transferFails) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(transferFails ? f.base : head);
  } finally { await f.session.close(); }
});
