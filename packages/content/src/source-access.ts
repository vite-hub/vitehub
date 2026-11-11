import type { GitHubPullRequest } from "@vite-hub/source"
import type { Diagnostic } from "nostics"

import type { ContentSourceRef } from "./source-refs.ts"

/** The label that makes the head commit of a fork pull request public. */
export const PREVIEW_LABEL = "preview:enabled"

/**
 * The branch prefix of the pull requests that the CMS opens with `publish: "pr"`, such as `vitehub/publish/1a2b3c4-...`.
 * These branches hold unreviewed drafts, so `allow()` keeps them private like the draft branch.
 */
export const publishBranchPrefix = "vitehub/publish/"

/** How long a server instance holds a decision that came from GitHub. A removed label shows after this time at most. */
export const ACCESS_HOLD_MS: number = 10 * 60_000

/**
 * Why `content.sources.allow()` lets a request read a ref.
 * - `published`: the published branch contains the commit.
 * - `pull`: the commit is the head of an open or merged pull request from the same repository.
 * - `label`: the commit is the head of an open or merged fork pull request with the `preview:enabled` label.
 * - `console`: the request has a valid preview cookie from `content.preview.enable()`.
 * - `token`: the request has a valid `?vitehub-content-token` from `content.sources.sign()` for this ref.
 */
export type ContentSourceAllowReason = "published" | "pull" | "label" | "console" | "token"

/**
 * Why `content.sources.allow()` denies a ref. A route answers 404 for every reason.
 * - `missing`: the ref is not valid, or the repository has no such ref.
 * - `private`: the ref is a private branch, such as the CMS draft branch or a CMS publish branch, or a pull request from it.
 * - `fork`: the ref is an open fork pull request without the `preview:enabled` label.
 * - `closed`: the ref is a pull request that was closed without a merge.
 * - `unpublished`: no rule above makes the commit public.
 */
export type ContentSourceDenyReason = "missing" | "private" | "fork" | "closed" | "unpublished"

/** The decision of `content.sources.allow()`. */
export type ContentSourceAccess =
  | {
    allowed: true
    reason: ContentSourceAllowReason
    /** The commit that the decision is for. Pass it to `content.sources.at()` to read that same commit. */
    target: ContentSourceRef
  }
  | {
    allowed: false
    reason: ContentSourceDenyReason
    /** `CONTENT_R0031`, for your logs, such as with `formatDiagnostic()` from `nostics`. Do not send its message: answer a plain 404. */
    error: Diagnostic<unknown>
  }

/** The GitHub facts that the public rule reads. */
export interface PublicRuleFacts {
  /** Whether the published branch contains the commit. */
  published(): Promise<boolean>
  /** The pull requests whose head commit is the commit. */
  pulls(): Promise<GitHubPullRequest[]>
}

/** Whether a branch is private: one that the app lists, such as the CMS draft branch, or a CMS publish branch. */
function isPrivateBranch(branch: string, privateBranches: ReadonlySet<string>): boolean {
  return privateBranches.has(branch) || branch.startsWith(publishBranchPrefix)
}

/** What a pull request makes public: its head commit, when it is open or merged, and from the same repository or labelled. */
function pullAllows(pull: GitHubPullRequest, privateBranches: ReadonlySet<string>): "pull" | "label" | undefined {
  if (pull.state !== "open" && !pull.merged) return
  if (!pull.fork) return isPrivateBranch(pull.head, privateBranches) ? undefined : "pull"
  return pull.labels.includes(PREVIEW_LABEL) ? "label" : undefined
}

/** Whether a ref is a private branch, or a pull request from one in the same repository. */
export function isPrivateRef(target: ContentSourceRef, privateBranches: ReadonlySet<string>): boolean {
  if (target.kind === "branch") return isPrivateBranch(target.ref, privateBranches)
  return target.kind === "pull" && target.pull !== null && !target.pull.fork && isPrivateBranch(target.pull.head, privateBranches)
}

/**
 * The public rule for a commit that is not a private ref. It asks GitHub only as much as it needs: a pull request ref
 * checks its own pull request, then the published branch. A branch or commit ref checks the published branch, then the
 * pull requests whose head is the commit.
 */
export async function publicRule(target: ContentSourceRef, facts: PublicRuleFacts, privateBranches: ReadonlySet<string>): Promise<ContentSourceAllowReason | ContentSourceDenyReason> {
  const pull = target.pull
  const own = pull && pullAllows(pull, privateBranches)
  if (own) return own
  if (await facts.published()) return "published"
  if (!pull) {
    for (const other of await facts.pulls()) {
      const reason = pullAllows(other, privateBranches)
      if (reason) return reason
    }
    return "unpublished"
  }
  if (pull.state === "closed" && !pull.merged) return "closed"
  return pull.fork ? "fork" : "unpublished"
}
