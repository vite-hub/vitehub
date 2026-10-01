import type { GitHubCheckEvidence, GitHubRequiredCheckState } from "../../server/github-required-checks.ts";
import type { Snapshot } from "../../server/github-inbox.ts";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";

export type BabysitterMergeMethod = "squash" | "merge" | "rebase";

export interface BabysitterMergeReadinessInput {
  repository: string;
  number: number;
  /** The head SHA that the merge will require. */
  head: string;
  snapshot: Snapshot;
  requiredChecks: GitHubRequiredCheckState;
}

/** Return `true` to allow the merge, or a reason that sends the PR to a normal pass. */
export type BabysitterMergeReady = (input: BabysitterMergeReadinessInput) => true | string | Promise<true | string>;

/**
 * - `false`: never merge.
 * - `"auto"`: the worker may request GitHub native auto-merge.
 * - `"direct"`: the host merges a ready PR before any model pass.
 */
export type BabysitterMerge =
  | false
  | "auto"
  | "direct"
  | { strategy: "direct"; method?: BabysitterMergeMethod; ready?: BabysitterMergeReady };

export type ResolvedBabysitterMerge =
  | { mode: "off" }
  | { mode: "auto" }
  | { mode: "direct"; method: BabysitterMergeMethod; ready?: BabysitterMergeReady };

export type MergeDecision = { ready: true; head: string } | { ready: false; reason: string };

const failing = new Set(["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const no = (reason: string): MergeDecision => ({ ready: false, reason });

export function resolveBabysitterMerge(merge: unknown, autoMerge: unknown): ResolvedBabysitterMerge {
  if (autoMerge === true && merge !== false && merge !== "auto") {
    throw new TypeError('[vitehub] Babysitter autoMerge is deprecated; set only merge: "auto".');
  }
  if (merge === false) return autoMerge === true ? { mode: "auto" } : { mode: "off" };
  if (merge === "auto") return { mode: "auto" };
  if (merge === "direct") return { mode: "direct", method: "squash" };
  if (isRuntimeRecord(merge) && merge.strategy === "direct") {
    const method = merge.method ?? "squash";
    if (method !== "squash" && method !== "merge" && method !== "rebase") {
      throw new TypeError('[vitehub] Babysitter merge.method must be "squash", "merge", or "rebase".');
    }
    if (merge.ready !== undefined && !hasRuntimeType(merge.ready, "function")) {
      throw new TypeError("[vitehub] Babysitter merge.ready must be a function.");
    }
    // SAFETY: the guard above proves ready is either undefined or a function with the documented contract.
    const ready = merge.ready as BabysitterMergeReady | undefined;
    return ready ? { mode: "direct", method, ready } : { mode: "direct", method };
  }
  throw new TypeError('[vitehub] Babysitter merge must be false, "auto", "direct", or { strategy: "direct" }.');
}

/** The current-head check runs and statuses retained in an inbox snapshot. */
export function snapshotCheckEvidence(snapshot: Snapshot): GitHubCheckEvidence {
  const head = snapshot.pr?.head?.sha ?? "";
  const checkRuns = Object.values(snapshot.checks).flatMap((check) => {
    if (check.deleted || check.head_sha !== head || !hasRuntimeType(check.id, "number") || !hasRuntimeType(check.name, "string")) return [];
    const app: unknown = check.app;
    return [{ id: check.id, head_sha: head, name: check.name, app: isRuntimeRecord(app) && hasRuntimeType(app.id, "number") ? { id: app.id } : null,
      status: String(check.status ?? ""), conclusion: check.conclusion === undefined || check.conclusion === null ? null : String(check.conclusion) }];
  });
  const statuses = Object.values(snapshot.statuses).flatMap((status, index) => {
    if (status.deleted || status.sha !== head || !hasRuntimeType(status.context, "string")) return [];
    return [{ id: hasRuntimeType(status.id, "number") ? status.id : index, sha: head, context: status.context, state: String(status.state ?? "") }];
  });
  return { repository: snapshot.repository, branch: snapshot.pr?.base?.ref ?? "", headSha: head, checkRuns, statuses };
}

/**
 * Decides from inbox evidence whether a PR needs only a merge. Any doubt returns a reason,
 * and the PR gets a normal pass. The live check in `liveMergeReadiness` still runs before merging.
 */
export function directMergeReadiness(snapshot: Snapshot, requiredChecks: GitHubRequiredCheckState): MergeDecision {
  const pr = snapshot.pr;
  const head = pr?.head?.sha;
  if (!pr || String(pr.state).toLowerCase() !== "open" || !head) return no("not an open pull request");
  if (pr.draft) return no("draft");
  if (requiredChecks !== "passed") return no(`required checks ${requiredChecks}`);
  const evidence = snapshotCheckEvidence(snapshot);
  if (evidence.checkRuns.some((check) => check.status.toLowerCase() !== "completed")) return no("a current-head check is still running");
  if (evidence.checkRuns.some((check) => failing.has(String(check.conclusion).toLowerCase()))) return no("a current-head check failed");
  if (evidence.statuses.some((status) => status.state !== "success")) return no("a current-head status is not successful");
  if (!snapshot.threadsHydrated) return no("review threads not loaded");
  if (snapshot.threads.some((thread) => thread.isResolved !== true)) return no("unresolved review threads");
  const hasUnthreadedFeedback = snapshot.reasons.some((reason) =>
    reason.startsWith("issue_comment:") || reason.startsWith("pull_request_review:") || reason.startsWith("pull_request_review_comment:"),
  ) && [...Object.values(snapshot.comments), ...Object.values(snapshot.reviews), ...Object.values(snapshot.reviewComments)]
    .some((feedback) => !feedback.deleted);
  if (hasUnthreadedFeedback) return no("unhandled non-thread feedback");
  return { ready: true, head };
}

/** GitHub's live PR must agree immediately before the merge. */
export function liveMergeReadiness(live: unknown, head: string): MergeDecision {
  if (!isRuntimeRecord(live)) return no("pull request unavailable");
  const liveHead = isRuntimeRecord(live.head) ? live.head.sha : undefined;
  const base = isRuntimeRecord(live.base) ? live.base : undefined;
  const repository = base && isRuntimeRecord(base.repo) ? base.repo : undefined;
  if (String(live.state).toLowerCase() !== "open") return no("pull request is no longer open");
  if (liveHead !== head) return no("head changed");
  if (live.draft === true) return no("draft");
  // A stacked PR keeps its old base after the parent merges when merged branches are kept.
  // Merging it there would strand the change outside the default branch.
  const defaultBranch = repository?.default_branch;
  if (!hasRuntimeType(defaultBranch, "string") || base?.ref !== defaultBranch) return no(`base ${String(base?.ref ?? "unknown")} is not the default branch`);
  if (live.mergeable_state !== "clean") return no(`mergeable_state ${String(live.mergeable_state ?? "unknown")}`);
  return { ready: true, head };
}
