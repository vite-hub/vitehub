import { parse } from "yaml";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import type { GitHubPullRequestRecord } from "./inbox/types.ts";
import type { BabysitterMergeMethod } from "./merge.ts";

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
 * merged into the default branch, the branch a parent merged into when that is another branch,
 * such as the branch of a pull request that the parent folded into, and undefined otherwise.
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
  const merged = parents.filter(parent => Boolean(field(parent, "merged_at")));
  if (merged.some(parent => field(parent, "base", "ref") === defaultBranch)) return defaultBranch;
  // A parent that merged into another branch did not land on the default branch. Its change is
  // on that branch, so the PR moves there and not to the default branch.
  const landed = merged.map(parent => field(parent, "base", "ref")).find(ref => hasRuntimeType(ref, "string") && ref !== base);
  return hasRuntimeType(landed, "string") ? landed : undefined;
}

/**
 * The open pull request whose head branch is this PR's base, when both head branches are in the base
 * repository. The host can fold this PR into that branch, so it lands with its parent. Returns undefined
 * for a fork's PR, for the default branch, and for a branch that no single open PR owns, such as a
 * long-lived integration branch.
 */
export function foldParent(pr: unknown, parents: readonly unknown[]): { number: number; branch: string } | undefined {
  const base = field(pr, "base", "ref");
  const repository = field(pr, "base", "repo", "full_name");
  const headRepository = field(pr, "head", "repo", "full_name");
  if (!hasRuntimeType(base, "string") || !hasRuntimeType(repository, "string") || !hasRuntimeType(headRepository, "string")) return undefined;
  if (headRepository.toLowerCase() !== repository.toLowerCase() || base === field(pr, "base", "repo", "default_branch")) return undefined;
  const open = parents.flatMap((parent) => {
    const number = field(parent, "number");
    return String(field(parent, "state")).toLowerCase() === "open" && field(parent, "head", "ref") === base
      && String(field(parent, "head", "repo", "full_name")).toLowerCase() === repository.toLowerCase()
      && hasRuntimeType(number, "number") && Number.isSafeInteger(number) && number !== field(pr, "number") ? [number] : [];
  });
  // Two open pull requests from one branch make the target unclear.
  return open.length === 1 ? { number: open[0]!, branch: base } : undefined;
}

export const stackChildBaseDeletion = "repository cleanup would delete an open child pull request's base branch";

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
    && field(child, "base", "ref") === branch) ? stackChildBaseDeletion : true;
}

/** Whether a PR's head branch lives in another repository than `repository`, such as a fork. */
export function isForkHead(pr: unknown, repository: string): boolean {
  const headRepository = field(pr, "head", "repo", "full_name");
  return hasRuntimeType(headRepository, "string") && headRepository.toLowerCase() !== repository.toLowerCase();
}

/** The head and base branch of a PR whose head branch lives in `repository`, which the host can push to. */
export function sameRepositoryBranches(pr: unknown, repository: string): { head: string; base: string } | undefined {
  const head = field(pr, "head", "ref");
  const base = field(pr, "base", "ref");
  const headRepository = field(pr, "head", "repo", "full_name");
  if (!hasRuntimeType(head, "string") || !hasRuntimeType(base, "string") || !hasRuntimeType(headRepository, "string")) return undefined;
  return headRepository.toLowerCase() === repository.toLowerCase() ? { head, base } : undefined;
}

/**
 * The merge method for a fold. Squash and rebase copy the child's commits, so a grandchild that moves onto
 * the parent's branch would show them again and can conflict on them. A merge commit keeps the child's
 * commits on the parent's branch. The parent's own merge into the default branch uses the configured method.
 */
export function foldMethod(method: BabysitterMergeMethod, repository: unknown): BabysitterMergeMethod {
  return isRuntimeRecord(repository) && repository.allow_merge_commit === false ? method : "merge";
}

/**
 * Whether a workflow can run on a push or creation of `branch`, including as a local reusable
 * workflow called by another workflow. Anything we cannot read counts as yes.
 */
export function runsOnPush(workflow: string, branch: string): boolean {
  let document: unknown;
  try { document = parse(workflow); } catch { return true; }
  if (!isRuntimeRecord(document)) return true;
  const on = document.on ?? document.true;
  if (typeof on === "string" || Array.isArray(on)) return [on].flat().some(event => event === "push" || event === "create" || event === "workflow_call");
  if (!isRuntimeRecord(on)) return true;
  if ("create" in on || "workflow_call" in on) return true;
  if (!("push" in on)) return false;
  const push = on.push;
  if (push == null) return true;
  if (!isRuntimeRecord(push)) return true;
  const list = (value: unknown) => value === undefined ? undefined : [value].flat().map(String);
  const branches = list(push.branches);
  const ignored = list(push["branches-ignore"]);
  // Complex branch filters count as matching.
  if ([...branches ?? [], ...ignored ?? []].some(pattern => /[[\\?+]/.test(pattern))) return true;
  // A push trigger with only tag filters never starts on a branch push.
  if (!branches && !ignored) return push.tags === undefined && push["tags-ignore"] === undefined;
  if (ignored) return !ignored.some(pattern => branchFilter(pattern).test(branch));
  let match = false;
  for (const pattern of branches!) {
    if (pattern.startsWith("!")) { if (branchFilter(pattern.slice(1)).test(branch)) match = false; }
    else if (branchFilter(pattern).test(branch)) match = true;
  }
  return match;
}

/** GitHub's branch filter pattern as a regular expression: `**` crosses `/`, `*` does not. */
function branchFilter(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") { source += ".*"; index++; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
