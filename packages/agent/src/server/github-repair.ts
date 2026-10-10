import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { assertGitHubDependenciesCurrent } from "./github-install.ts";

const exec = promisify(execFile);

export interface GitHubRepairCommit {
  message: string;
  paths: string[];
}

/** Git metadata is protected by provider sandboxes. Only the host stages repairs. */
export async function commitGitHubPullRequestWorkspace(
  target: string,
  input: GitHubRepairCommit,
  options: { expectedHead: string; signal?: AbortSignal; identity?: Record<string, string | undefined>; verifyDependencies?: boolean },
): Promise<string> {
  options.signal?.throwIfAborted();
  if (!input.message.trim() || !input.paths.length) throw new Error("A repair message and explicit file paths are required.");
  for (const path of input.paths) {
    if (!path || path === "." || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git") || path.includes("\0")) {
      throw new Error("Repair paths must name files inside the assigned checkout.");
    }
    const entry = await lstat(join(target, path)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isDirectory()) throw new Error("Repair paths must name individual files.");
  }
  if (!(await lstat(join(target, ".git"))).isDirectory()) throw new Error("Repair requires an independent prepared Git directory.");
  const git = repairGit(target, options);
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(target)) throw new Error("Repair target must be its checkout root.");
  await git("merge-base", "--is-ancestor", options.expectedHead, "HEAD");
  const recordPath = join(target, ".git", "vitehub-merge.json");
  const rawRecord = await readFile(recordPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  const mergeRecord = rawRecord === undefined ? undefined : v.parse(mergeRecordSchema, JSON.parse(rawRecord));
  if (mergeRecord) {
    if (mergeRecord.head !== options.expectedHead || await git("rev-parse", "HEAD") !== mergeRecord.head
      || (await readFile(join(target, ".git", "MERGE_HEAD"), "utf8")).trim() !== mergeRecord.base
      || digest(await git("ls-files", "--stage", "-z")) !== mergeRecord.index) throw new Error("Prepared merge metadata or index changed outside the host repair tools.");
  } else if (await git("diff", "--cached", "--name-only")) throw new Error("Repair checkout contains unrelated staged changes.");
  // Restored tracked instructions can retain the provider's skip-worktree flag.
  // Only the explicitly authorized paths may cross that sparse boundary.
  const skipped = (await git("ls-files", "-v", "-z", "--", ...input.paths)).split("\0")
    .filter(entry => /^[Ss] /.test(entry)).map(entry => entry.slice(2));
  if (skipped.length) await git("update-index", "--no-skip-worktree", "--", ...skipped);
  await git("add", "--sparse", "--", ...input.paths);
  if (mergeRecord) {
    await writeFile(recordPath, JSON.stringify({ ...mergeRecord, index: digest(await git("ls-files", "--stage", "-z")) }));
    const unresolved = await git("diff", "--name-only", "--diff-filter=U");
    if (unresolved) throw new Error(`Resolve the remaining merge conflicts and call commitRepair with their file paths: ${unresolved}`);
  }
  if (options.verifyDependencies) {
    const directory = await mkdtemp(join(target, ".git", "vitehub-commit-snapshot-"));
    try {
      // The protected Git index is the source of the commit. Provider writes
      // to checkout files cannot change this validation snapshot.
      const tree = await git("write-tree");
      await git("checkout-index", "--all", `--prefix=${directory}/`);
      await assertGitHubDependenciesCurrent(target, directory);
      if (await git("write-tree") !== tree) throw new Error("Repair index changed during dependency validation.");
    } catch (error) {
      // A rejected ordinary repair must be stageable again after refresh.
      // Prepared merges retain their host-recorded conflict-resolution index.
      if (!mergeRecord) await git("reset", "--quiet", "HEAD", "--", ...input.paths);
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (mergeRecord || await git("diff", "--cached", "--name-only")) await git("commit", "-m", input.message);
  if (mergeRecord) await rm(recordPath);
  options.signal?.throwIfAborted();
  return await git("rev-parse", "HEAD");
}

const mergeRecordSchema = v.object({ head: v.string(), base: v.string(), index: v.string() });
const digest = (index: string) => createHash("sha256").update(index).digest("hex");
function repairGit(target: string, options: { signal?: AbortSignal; identity?: Record<string, string | undefined>; env?: Record<string, string> }) {
  // No shell credentials, ambient Git bindings, global configuration, hooks,
  // signing programs or filesystem monitors may run during a host commit.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...options.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: options.identity?.GIT_AUTHOR_NAME ?? "ViteHub Babysitter",
    GIT_AUTHOR_EMAIL: options.identity?.GIT_AUTHOR_EMAIL ?? "babysitter@vitehub.dev",
    GIT_COMMITTER_NAME: options.identity?.GIT_COMMITTER_NAME ?? "ViteHub Babysitter",
    GIT_COMMITTER_EMAIL: options.identity?.GIT_COMMITTER_EMAIL ?? "babysitter@vitehub.dev",
  };
  return async (...args: string[]) => (await exec("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], { cwd: target, env, signal: options.signal, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

}

/** Prepare an exact-base merge on the host before Git metadata becomes read-only. */
export async function prepareGitHubRepairBase(target: string, options: { expectedHead: string; base: string; signal?: AbortSignal; fetch?: { url: string; env: Record<string, string> } }): Promise<void> {
  if (!/^[a-f\d]{40}$/i.test(options.base)) throw new Error("Repair base must be an exact commit SHA.");
  const git = repairGit(target, options);
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(target) || !(await lstat(join(target, ".git"))).isDirectory()) throw new Error("Base merge requires an independent prepared checkout.");
  if (await git("rev-parse", "HEAD") !== options.expectedHead || await git("status", "--porcelain")) throw new Error("Base merge requires the clean assigned PR head.");
  // The live branch may have advanced after the checkout fetched its objects.
  // This runs only during host preparation, before provider writes are admitted.
  if (options.fetch) await repairGit(target, { signal: options.signal, env: options.fetch.env })("fetch", "--no-tags", "--", options.fetch.url, options.base);
  await git("cat-file", "-e", `${options.base}^{commit}`);
  try {
    await git("merge", "--no-commit", "--no-ff", "--no-verify", "--", options.base);
  } catch (error) {
    if (!await git("diff", "--name-only", "--diff-filter=U")) throw error;
  }
  const mergeHead = await readFile(join(target, ".git", "MERGE_HEAD"), "utf8").catch(() => undefined);
  if (!mergeHead) return;
  if (mergeHead.trim() !== options.base) throw new Error("Prepared merge selected a different base.");
  await writeFile(join(target, ".git", "vitehub-merge.json"), JSON.stringify({ head: options.expectedHead, base: options.base, index: digest(await git("ls-files", "--stage", "-z")) }));
}
