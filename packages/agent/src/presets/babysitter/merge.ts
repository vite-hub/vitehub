import { createHash } from "node:crypto";
import type { GitHubCheckEvidence, GitHubRequiredCheckState } from "../../server/github-required-checks.ts";
import type { GitHubEvidence, Snapshot } from "../../server/github-inbox.ts";
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
const pending = new Set(["queued", "in_progress", "pending", "waiting", "requested", "rerequested", "created"]);

export interface BabysitterMergeEvidence {
  /** Verified host identities. Their comments and reviews are never external feedback. */
  workerAuthors?: ReadonlySet<string>;
  /** Configured logins, such as deployment preview bots, whose items never need an assessment. */
  ignoreFeedbackAuthors?: ReadonlySet<string>;
  /** Body prefixes of feedback that reports no findings. */
  noFindingsReviews?: readonly string[];
  /** Fingerprints of feedback that an earlier pass assessed or answered with a repair push. */
  assessedFeedback?: ReadonlySet<string>;
  /** Configured review integrations that block only while their current-head review is active. */
  pendingReviewChecks?: ReadonlySet<string>;
  /** Host-recorded evidence from an explicit assessment of this exact head and feedback. */
  reviewedEvidenceKey?: string;
}

type FeedbackPolicy = Pick<BabysitterMergeEvidence, "workerAuthors" | "ignoreFeedbackAuthors" | "noFindingsReviews">;

function feedbackAuthor(value: GitHubEvidence): string {
  return String(value.user?.login ?? value.author?.login ?? "").toLowerCase();
}

function botAuthor(value: GitHubEvidence): boolean {
  const user = value.user ?? value.author;
  return String(user?.type ?? user?.__typename ?? "").toLowerCase() === "bot" || feedbackAuthor(value).endsWith("[bot]");
}

/**
 * Feedback that never needs a model assessment: deleted items, the worker's own items, configured
 * authors, items without a body and configured no-findings verdicts. Requested changes always count.
 */
function ignoredFeedback(value: GitHubEvidence, policy: FeedbackPolicy): boolean {
  if (value.deleted) return true;
  if (String(value.state).toUpperCase() === "CHANGES_REQUESTED") return false;
  const author = feedbackAuthor(value);
  if (policy.workerAuthors?.has(author) || policy.ignoreFeedbackAuthors?.has(author)) return true;
  const body = String(value.body ?? "").trim();
  return !body || (policy.noFindingsReviews ?? []).some(prefix => body.startsWith(prefix));
}

type FeedbackItem = { id: string; body: unknown; state: unknown; user: unknown; commit: unknown; path: unknown; line: unknown };

/** Bot issue comments are activity panels that bots edit in place. Without `botBodies`, their identity is the evidence. */
function feedback(values: Record<string, GitHubEvidence>, policy: FeedbackPolicy, botBodies = true): FeedbackItem[] {
  return Object.entries(values).filter(([, value]) => !ignoredFeedback(value, policy))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => ({ id, body: botBodies || !botAuthor(value) ? value.body : undefined, state: value.state,
      user: value.user ?? value.author, commit: value.commit_id ?? value.commit?.oid, path: value.path, line: value.line }));
}

function mergeTarget(snapshot: Snapshot) {
  const base = snapshot.pr?.base;
  // Exclude transport metadata and repository counters from the target identity.
  return base && { sha: base.sha, ref: base.ref,
    repository: (base.repo?.full_name ?? snapshot.repository).toLowerCase() };
}

/** Assessment is bound to full feedback bodies and failed check evidence, never prose heuristics. */
export function mergeReviewEvidenceKey(snapshot: Snapshot, policy: FeedbackPolicy = {}): string {
  const head = snapshot.pr?.head?.sha;
  // doctor-disable-next-line typescript/performance/no-array-filter-map -- Evidence normalization intentionally filters before mapping to retain only current-head failures.
  const failures = [...Object.values(snapshot.checks), ...Object.values(snapshot.statuses)]
    .filter(value => !value.deleted && (value.head_sha ?? value.sha) === head
      && failing.has(String(value.conclusion ?? value.state).toLowerCase()))
    .map(value => ({ id: value.id ?? value.context, name: value.name ?? value.context,
      state: value.conclusion ?? value.state, app: value.app, description: value.description, output: value.output }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const threads = snapshot.threads.map(thread => ({ id: thread.node_id ?? thread.id, path: thread.path, isResolved: thread.isResolved,
    comments: (Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? [])
      .filter(comment => !comment.deleted).map(comment => ({ id: comment.node_id ?? comment.id,
        body: comment.body, user: comment.user ?? comment.author, commit: comment.commit_id ?? comment.commit?.oid })) }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash("sha256").update(JSON.stringify({ head, headRef: snapshot.pr?.head?.ref, headRepository: snapshot.pr?.head?.repo?.full_name,
    draft: snapshot.pr?.draft, title: snapshot.pr?.title, body: snapshot.pr?.body,
    // Repository counters and timestamps change on unrelated pushes. Only the
    // target ref, commit and repository identity define this merge input.
    base: mergeTarget(snapshot),
    comments: feedback(snapshot.comments, policy, false), reviews: feedback(snapshot.reviews, policy),
    reviewComments: feedback(snapshot.reviewComments, policy), threads, failures })).digest("hex");
}

/**
 * Identities of the feedback items that need an assessment. An explicit assessment covers
 * the items it saw on the same merge target. A new base repository, ref or commit needs reassessment,
 * while a later head on the same target only needs a pass for feedback that arrived since.
 */
export function feedbackFingerprints(snapshot: Snapshot, policy: FeedbackPolicy = {}): string[] {
  const kinds: Array<[string, FeedbackItem[]]> = [["comment", feedback(snapshot.comments, policy, false)],
    ["review", feedback(snapshot.reviews, policy)], ["review-comment", feedback(snapshot.reviewComments, policy)]];
  const target = mergeTarget(snapshot);
  return kinds.flatMap(([kind, values]) => values.map(value =>
    createHash("sha256").update(JSON.stringify([target, kind, value.id, value.body, value.state])).digest("hex").slice(0, 32)));
}

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
    return [{ id: check.id, head_sha: head, name: check.name, app: hasRuntimeType(check.app?.id, "number") ? { id: check.app.id } : null,
      status: String(check.status ?? ""), conclusion: check.conclusion === undefined || check.conclusion === null ? null : String(check.conclusion) }];
  });
  // A rerun keeps the earlier run in the snapshot. Only the newest run of each check is evidence.
  const newest = new Map<string, (typeof checkRuns)[number]>();
  for (const check of checkRuns) {
    const key = `${check.name}\0${check.app?.id ?? ""}`;
    const previous = newest.get(key);
    if (!previous || check.id > previous.id) newest.set(key, check);
  }
  const statuses = Object.values(snapshot.statuses).flatMap((status, index) => {
    if (status.deleted || status.sha !== head || !hasRuntimeType(status.context, "string")) return [];
    return [{ id: hasRuntimeType(status.id, "number") ? status.id : index, sha: head, context: status.context, state: String(status.state ?? "") }];
  });
  return { repository: snapshot.repository, branch: snapshot.pr?.base?.ref ?? "", headSha: head, checkRuns: [...newest.values()], statuses };
}

/**
 * Decides from inbox evidence whether a PR needs only a merge. Any doubt returns a reason,
 * and the PR gets a normal pass. The live check in `liveMergeReadiness` still runs before merging.
 */
export function directMergeReadiness(snapshot: Snapshot, requiredChecks: GitHubRequiredCheckState, assessment: BabysitterMergeEvidence = {}): MergeDecision {
  const pr = snapshot.pr;
  const head = pr?.head?.sha;
  if (!pr || String(pr.state).toLowerCase() !== "open" || !head) return no("not an open pull request");
  if (pr.draft) return no("draft");
  if (requiredChecks !== "passed") return no(`required checks ${requiredChecks}`);
  const evidence = snapshotCheckEvidence(snapshot);
  const reviewChecks = assessment.pendingReviewChecks ?? new Set<string>();
  if (evidence.checkRuns.some(check => reviewChecks.has(check.name.toLowerCase()) && pending.has(check.status.toLowerCase()))
    || evidence.statuses.some(status => reviewChecks.has(status.context.toLowerCase()) && pending.has(status.state.toLowerCase()))) {
    return no("a current-head review is still running");
  }
  const failedChecks = evidence.checkRuns.some(check => failing.has(String(check.conclusion).toLowerCase()))
    || evidence.statuses.some(status => failing.has(status.state.toLowerCase()));
  const assessed = assessment.assessedFeedback ?? new Set<string>();
  const unassessed = feedbackFingerprints(snapshot, assessment).filter(id => !assessed.has(id)).length;
  if ((failedChecks || unassessed) && assessment.reviewedEvidenceKey !== mergeReviewEvidenceKey(snapshot, assessment)) {
    return no(failedChecks ? "current-head failures need assessment" : `${unassessed} new feedback item${unassessed === 1 ? " needs" : "s need"} assessment`);
  }
  if (!snapshot.threadsHydrated) return no("review threads not loaded");
  if (snapshot.threads.some((thread) => thread.isResolved !== true)) return no("unresolved review threads");
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
  if (live.mergeable === false) return no("merge conflict");
  if (live.reviewDecision === "CHANGES_REQUESTED" || live.reviewDecision === "REVIEW_REQUIRED") return no("required review not satisfied");
  // A stacked PR keeps its old base after the parent merges when merged branches are kept.
  // Merging it there would strand the change outside the default branch.
  const defaultBranch = repository?.default_branch;
  if (!hasRuntimeType(defaultBranch, "string") || base?.ref !== defaultBranch) return no(`base ${String(base?.ref ?? "unknown")} is not the default branch`);
  // GitHub uses "unstable" for failing optional checks. The required-check policy and
  // explicit assessment already gate those; GitHub still enforces branch rules atomically.
  if (live.mergeable_state !== "clean" && live.mergeable_state !== "unstable") return no(`mergeable_state ${String(live.mergeable_state ?? "unknown")}`);
  return { ready: true, head };
}
