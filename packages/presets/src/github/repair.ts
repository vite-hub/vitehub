import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { invariantError } from "@vite-hub/internal/invariant";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";
import { findGitHubBaseReverts } from "./base-reverts.ts";
import type { GitHubBaseRevert } from "./base-reverts.ts";
import { resolveGitHubMergeConflicts } from "./conflicts.ts";
import type { GitHubConflictOptions, GitHubConflictResolution } from "./conflicts.ts";
import { assertGitHubDependenciesCurrent } from "./install.ts";

const exec = promisify(execFile);

export interface GitHubRepairCommit {
  message: string;
  paths: string[];
  /** Files where a base merge intentionally keeps the PR's version over a base change, each with the reason. */
  baseOverrides?: Array<{ path: string; reason: string }>;
}

/** Git metadata is protected by provider sandboxes. Only the host stages repairs. */
export async function commitGitHubPullRequestWorkspace(
  target: string,
  input: GitHubRepairCommit,
  options: { expectedHead: string; signal?: AbortSignal; identity?: Record<string, string | undefined>; verifyDependencies?: boolean },
): Promise<string> {
  options.signal?.throwIfAborted();
  if (!input.message.trim() || !input.paths.length) throw presetsErrorDiagnostics.PRESETS_REPAIR_INPUT_MISSING();
  for (const path of input.paths) {
    if (!path || path === "." || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git") || path.includes("\0")) {
      throw presetsErrorDiagnostics.PRESETS_REPAIR_PATH_INVALID();
    }
    const entry = await lstat(join(target, path)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isDirectory()) throw presetsErrorDiagnostics.PRESETS_REPAIR_PATH_DIRECTORY();
  }
  if (!(await lstat(join(target, ".git"))).isDirectory()) throw invariantError("the GitHub host passes the root of its own prepared clone to the repair")
  const git = repairGit(target, options);
  let message = input.message;
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(target)) throw invariantError("the GitHub host passes the checkout root of its own clone to the repair")
  await git("merge-base", "--is-ancestor", options.expectedHead, "HEAD");
  const recordPath = join(target, ".git", "vitehub-merge.json");
  const rawRecord = await readFile(recordPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  const mergeRecord = rawRecord === undefined ? undefined : v.parse(mergeRecordSchema, JSON.parse(rawRecord));
  if (mergeRecord) {
    if (mergeRecord.head !== options.expectedHead || await git("rev-parse", "HEAD") !== mergeRecord.head
      || (await readFile(join(target, ".git", "MERGE_HEAD"), "utf8")).trim() !== mergeRecord.base
      || digest(await git("ls-files", "--stage", "-z")) !== mergeRecord.index) throw presetsErrorDiagnostics.PRESETS_REPAIR_MERGE_CHANGED();
  } else if (await git("diff", "--cached", "--name-only")) throw presetsErrorDiagnostics.PRESETS_REPAIR_STAGED_CHANGES();
  // Restored tracked instructions can retain the provider's skip-worktree flag.
  // Only the explicitly authorized paths may cross that sparse boundary.
  const skipped = (await git("ls-files", "-v", "-z", "--", ...input.paths)).split("\0")
    .filter(entry => /^[Ss] /.test(entry)).map(entry => entry.slice(2));
  if (skipped.length) await git("update-index", "--no-skip-worktree", "--", ...skipped);
  await git("add", "--sparse", "--", ...input.paths);
  if (mergeRecord) {
    await writeFile(recordPath, JSON.stringify({ ...mergeRecord, index: digest(await git("ls-files", "--stage", "-z")) }));
    const unresolved = await git("diff", "--name-only", "--diff-filter=U");
    if (unresolved) throw presetsErrorDiagnostics.PRESETS_REPAIR_CONFLICTS_UNRESOLVED({ files: unresolved });
    const reasons = new Map(input.baseOverrides?.map(({ path, reason }) => [path, reason.trim()]));
    const reverts = await findGitHubBaseReverts(git.raw, mergeRecord);
    const unexplained = reverts.filter(({ path }) => !reasons.get(path));
    if (unexplained.length) throw presetsErrorDiagnostics.PRESETS_REPAIR_BASE_REVERTED({ files: describeBaseReverts(unexplained) });
    if (reverts.length) message += `\n\nKeeps this PR's version over base changes:\n${reverts.map(({ path }) => `- ${path}: ${reasons.get(path)}`).join("\n")}`;
  }
  if (options.verifyDependencies) {
    const directory = await mkdtemp(join(target, ".git", "vitehub-commit-snapshot-"));
    try {
      // The protected Git index is the source of the commit. Provider writes
      // to checkout files cannot change this validation snapshot.
      const tree = await git("write-tree");
      await git("checkout-index", "--all", `--prefix=${directory}/`);
      await assertGitHubDependenciesCurrent(target, directory);
      if (await git("write-tree") !== tree) throw presetsErrorDiagnostics.PRESETS_REPAIR_INDEX_CHANGED();
    } catch (error) {
      // A rejected ordinary repair must be stageable again after refresh.
      // Prepared merges retain their host-recorded conflict-resolution index.
      if (!mergeRecord) await git("reset", "--quiet", "HEAD", "--", ...input.paths);
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (mergeRecord || await git("diff", "--cached", "--name-only")) await git("commit", "-m", message);
  if (mergeRecord) await rm(recordPath);
  options.signal?.throwIfAborted();
  return await git("rev-parse", "HEAD");
}

const mergeRecordSchema = v.object({
  head: v.string(), base: v.string(), index: v.string(),
  // What the host resolved before the model started. The model reads it from the record.
  conflicts: v.optional(v.object({
    conflicted: v.array(v.string()),
    resolved: v.array(v.object({ path: v.string(), rule: v.picklist(["package-json", "pnpm-lockfile", "markdown-union"]) })),
    remaining: v.array(v.string()),
    lockfile: v.optional(v.string()),
  })),
});
function describeBaseReverts(reverts: GitHubBaseRevert[]) {
  const quote = (line: string) => JSON.stringify(line.length > 100 ? `${line.slice(0, 100)}…` : line);
  return reverts.slice(0, 10).map(({ path, dropped, restored }) => [
    `${path}:`,
    dropped.length ? ` drops ${dropped.length} base line(s) such as ${dropped.slice(0, 2).map(quote).join(", ")}` : "",
    dropped.length && restored.length ? ";" : "",
    restored.length ? ` restores ${restored.length} line(s) the base removed, such as ${restored.slice(0, 2).map(quote).join(", ")}` : "",
  ].join("")).join("\n") + (reverts.length > 10 ? `\nand ${reverts.length - 10} more files` : "");
}
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
    GIT_AUTHOR_NAME: options.identity?.GIT_AUTHOR_NAME ?? "ViteHub Agent",
    GIT_AUTHOR_EMAIL: options.identity?.GIT_AUTHOR_EMAIL ?? "agent@vitehub.dev",
    GIT_COMMITTER_NAME: options.identity?.GIT_COMMITTER_NAME ?? "ViteHub Agent",
    GIT_COMMITTER_EMAIL: options.identity?.GIT_COMMITTER_EMAIL ?? "agent@vitehub.dev",
  };
  const raw = async (...args: string[]) => (await exec("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], { cwd: target, env, signal: options.signal, maxBuffer: 64 * 1024 * 1024 })).stdout;
  return Object.assign(async (...args: string[]) => (await raw(...args)).trim(), { raw });
}

/**
 * Prepare an exact-base merge on the host before Git metadata becomes read-only. Conflicts that need
 * no judgment are resolved and staged; the result lists them when the merge conflicted.
 */
export async function prepareGitHubRepairBase(target: string, options: { expectedHead: string; base: string; signal?: AbortSignal; fetch?: { url: string; env: Record<string, string> }; conflicts?: Omit<GitHubConflictOptions, "signal"> }): Promise<GitHubConflictResolution | undefined> {
  if (!/^[a-f\d]{40}$/i.test(options.base)) throw invariantError("the Babysitter passes the exact base commit SHA that it read from GitHub")
  const git = repairGit(target, options);
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(target) || !(await lstat(join(target, ".git"))).isDirectory()) throw invariantError("the Babysitter merges the base in the root of its own prepared clone")
  if (await git("rev-parse", "HEAD") !== options.expectedHead || await git("status", "--porcelain")) throw invariantError("the Babysitter merges the base on a clean clone of the assigned pull request head")
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
  if (!mergeHead) return undefined;
  if (mergeHead.trim() !== options.base) throw invariantError("the prepared merge uses the base commit SHA that the Babysitter read from GitHub")
  // Host resolutions are staged before the digest, so commitRepair accepts them as host work.
  const conflicts = await resolveGitHubMergeConflicts(target, git.raw, { ...options.conflicts, signal: options.signal });
  await writeFile(join(target, ".git", "vitehub-merge.json"), JSON.stringify({ head: options.expectedHead, base: options.base, index: digest(await git("ls-files", "--stage", "-z")), conflicts }));
  return conflicts;
}
