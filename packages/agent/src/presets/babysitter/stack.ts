import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type { GitHubPullRequestRecord } from "../../server/github-inbox.ts";

const field = (value: unknown, ...path: string[]): unknown => {
  let current = value;
  for (const key of path) current = isRuntimeRecord(current) ? current[key] : undefined;
  return current;
};

/** The base branch and owner of a PR that targets a branch other than the default branch. */
export function nonDefaultBase(pr: GitHubPullRequestRecord): { base: string; owner: string } | undefined {
  const base = pr.base?.ref;
  const owner = field(pr, "base", "repo", "owner", "login");
  if (!base || !hasRuntimeType(owner, "string") || base === field(pr, "base", "repo", "default_branch")) return undefined;
  return { base, owner };
}

/**
 * When a repository keeps merged branches, GitHub does not retarget a stacked PR after its
 * parent merges. Returns the default branch when the PR's base branch belongs to a parent that
 * merged into the default branch, and undefined otherwise.
 */
export function stackRetargetBase(pr: GitHubPullRequestRecord, baseBranchPulls: readonly unknown[]): string | undefined {
  const defaultBranch = field(pr, "base", "repo", "default_branch");
  const base = pr.base?.ref;
  if (!hasRuntimeType(defaultBranch, "string") || !base || base === defaultBranch) return undefined;
  const owner = field(pr, "base", "repo", "owner", "login");
  const parents = baseBranchPulls.filter(parent => field(parent, "head", "ref") === base
    && (!hasRuntimeType(owner, "string") || field(parent, "head", "repo", "owner", "login") === owner));
  // A reused branch name is not enough to identify the current parent. The
  // parent's head must be the commit currently recorded as the child's base.
  const baseSha = pr.base?.sha;
  if (!hasRuntimeType(baseSha, "string") || !parents.some(parent => field(parent, "head", "sha") === baseSha)) return undefined;
  // An open parent still owns the base branch.
  if (parents.some(parent => String(field(parent, "state")).toLowerCase() === "open")) return undefined;
  // A parent merged into another stale branch did not land; retargeting would add its unlanded change.
  if (!parents.some(parent => field(parent, "head", "sha") === baseSha && Boolean(field(parent, "merged_at")) && field(parent, "base", "ref") === defaultBranch)) return undefined;
  return defaultBranch;
}
