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
  // An open parent still owns the base branch.
  if (parents.some(parent => String(field(parent, "state")).toLowerCase() === "open")) return undefined;
  // A parent merged into another stale branch did not land; retargeting would add its unlanded change.
  if (!parents.some(parent => Boolean(field(parent, "merged_at")) && field(parent, "base", "ref") === defaultBranch)) return undefined;
  return defaultBranch;
}

/** GitHub's repository setting may delete a parent branch as part of merging it. */
export function directMergeBranchSafety(repository: unknown, pr: unknown, openChildren: readonly unknown[]): true | string {
  if (!isRuntimeRecord(repository) || !hasRuntimeType(repository.delete_branch_on_merge, "boolean")) {
    return "repository branch cleanup policy unavailable";
  }
  if (!repository.delete_branch_on_merge) return true;
  const headRepository = field(pr, "head", "repo", "full_name");
  const baseRepository = field(pr, "base", "repo", "full_name");
  if (!hasRuntimeType(headRepository, "string") || !hasRuntimeType(baseRepository, "string")) {
    return "pull request source repository unavailable";
  }
  if (headRepository.toLowerCase() !== baseRepository.toLowerCase()) return true;
  const branch = field(pr, "head", "ref");
  if (!hasRuntimeType(branch, "string")) return "pull request source branch unavailable";
  return openChildren.some(child => String(field(child, "state")).toLowerCase() === "open"
    && field(child, "base", "ref") === branch) ? "repository cleanup would delete an open child pull request's base branch" : true;
}
