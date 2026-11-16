import type { GitHubConflictGit } from "./conflicts.ts";

/** A file where a staged merge undoes part of what the base changed since the PR branched. */
export interface GitHubBaseRevert {
  path: string;
  /** Lines the base added that the merge result lacks. */
  dropped: string[];
  /** Lines the base removed that the merge result has again. */
  restored: string[];
}

// The host regenerates lockfiles from the merged manifests, so their lines say nothing about intent.
const lockfile = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;

/**
 * Find base changes that a staged merge of `base` into the PR `head` undoes.
 *
 * A resolution that keeps the PR's stale copy of a file silently reverts work that already landed, and
 * reviewers skip base merges. Each file that both the base changed and the staged result changes against
 * the base is compared as a multiset of trimmed lines across the merge base, base, PR head and index:
 * the result must keep every line the base added unless the PR removed it, and must not bring back a
 * line the base removed unless the PR added it.
 */
export async function findGitHubBaseReverts(git: GitHubConflictGit, options: { head: string; base: string }): Promise<GitHubBaseRevert[]> {
  const origin = (await git("merge-base", options.head, options.base)).trim();
  const changedByBase = new Set(names(await git("diff", "--name-only", "--no-renames", "-z", origin, options.base)));
  const candidates = names(await git("diff", "--cached", "--name-only", "--no-renames", "-z", options.base))
    .filter(path => changedByBase.has(path) && !lockfile.test(path));
  const reverts: GitHubBaseRevert[] = [];
  for (const path of candidates) {
    const [o, b, p, r] = await Promise.all([`${origin}:${path}`, `${options.base}:${path}`, `${options.head}:${path}`, `:${path}`].map(spec => blob(git, spec)));
    if ([o, b, p, r].some(text => text.includes("\0"))) continue;
    const revert = revertedLines(o, b, p, r);
    if (revert.dropped.length || revert.restored.length) reverts.push({ path, ...revert });
  }
  return reverts;
}

/** Compare one file's merge base, base, PR head and merge result. */
export function revertedLines(origin: string, base: string, head: string, result: string): Omit<GitHubBaseRevert, "path"> {
  const [o, b, p, r] = [origin, base, head, result].map(lineCounts);
  // Lines that neither the merge base nor the base has: the PR's own lines and the resolution's rewrites.
  // A stale copy of the file adds only merge-base lines, so it never appears here.
  const rewrites = [...r.keys()].filter(line => !o.has(line) && !b.has(line)).map(words);
  const dropped: string[] = [];
  const restored: string[] = [];
  for (const line of new Set([...o.keys(), ...b.keys()])) {
    const before = o.get(line) ?? 0;
    const byBase = (b.get(line) ?? 0) - before;
    const byHead = (p.get(line) ?? 0) - before;
    const kept = r.get(line) ?? 0;
    // A base line that the resolution rewrote to the PR's conventions, such as a changed call or count, is kept.
    if (byBase > 0 && kept < before + byBase + Math.min(0, byHead) && !rewrites.some(rewrite => similar(words(line), rewrite))) dropped.push(line);
    if (byBase < 0 && kept > before + byBase + Math.max(0, byHead)) restored.push(line);
  }
  return { dropped, restored };
}

const words = (line: string) => new Set(line.match(/[\p{L}\p{N}_]+/gu));
function similar(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= 0.6;
}

// Braces, blank lines and other short punctuation move freely in a correct merge.
function lineCounts(text: string) {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length >= 4 && /[\p{L}\p{N}]/u.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

async function blob(git: GitHubConflictGit, spec: string) {
  // A path that is absent on one side reads as an empty file.
  return await git("cat-file", "-e", spec).then(() => git("cat-file", "blob", spec), () => "");
}

const names = (output: string) => output.split("\0").filter(Boolean);
