import { createHash } from "node:crypto";
import type { GitHubCheckEvidence, GitHubRequiredCheckState } from "../github/index.ts";
import type { GitHubEvidence, GitHubReviewThread } from "./inbox/types.ts";
import type { Snapshot } from "./inbox/store.ts";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import { isBabysitterCheckRun } from "./check-run.ts";
import { hasGitHubLogin } from "./pull-request-filter.ts";

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
 * - `"direct"`: the host merges a ready PR before any model pass, with the `"approved-if-outside"` gate.
 * - `{ strategy: "direct", ready }`: a direct merge with another gate. `ready` is a
 *   {@link BabysitterMergeReady} callback or `"approved-if-outside"`, the default: a PR whose author
 *   is not an owner, member or collaborator of the repository merges only after a reviewer with write
 *   access approves its current head, and while no such reviewer's latest review requests changes.
 *   A push after the approval needs a new one. `ready: () => true` merges every ready PR.
 */
export type BabysitterMerge =
  | false
  | "auto"
  | "direct"
  | {
    strategy: "direct";
    method?: BabysitterMergeMethod;
    ready?: BabysitterMergeReady | "approved-if-outside";
    /**
     * Logins whose reviewed drafts the host marks ready for review. Only drafts whose head
     * branch is in the repository itself qualify, so a fork's draft stays a draft.
     */
    markDraftsReady?: readonly string[];
  };

export type ResolvedBabysitterMerge =
  | { mode: "off" }
  | { mode: "auto" }
  | { mode: "direct"; method: BabysitterMergeMethod; ready?: BabysitterMergeReady; markDraftsReady?: ReadonlySet<string> };

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
  /**
   * The PR spent its review push budget. Bot feedback, bot-only review threads and running or failed
   * `pendingReviewChecks` no longer need an assessment, so required checks alone can merge it.
   */
  automatedReviewSettled?: boolean;
  /** Unresolved review threads with only bot comments do not block once their comments are assessed. */
  ignoreAssessedBotThreads?: boolean;
}

type FeedbackPolicy = Pick<BabysitterMergeEvidence, "workerAuthors" | "ignoreFeedbackAuthors" | "noFindingsReviews" | "automatedReviewSettled">;

function feedbackAuthor(value: GitHubEvidence): string {
  return String(value.user?.login ?? value.author?.login ?? "").toLowerCase();
}

/** Feedback from a GitHub App or another bot account. GraphQL names an App by its login and a `Bot` typename. */
export function isAutomatedFeedback(value: GitHubEvidence): boolean {
  const user = value.user ?? value.author;
  return String(user?.type ?? user?.__typename ?? "").toLowerCase() === "bot" || feedbackAuthor(value).endsWith("[bot]");
}
const botAuthor = isAutomatedFeedback;

/** A review thread with a comment from a person. Comments from the worker and from bots do not count. */
export function hasHumanComment(thread: GitHubReviewThread, workerAuthors: ReadonlySet<string> = new Set()): boolean {
  const comments = Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? [];
  return comments.some(comment => !comment.deleted && !isAutomatedFeedback(comment) && !hasGitHubLogin(workerAuthors, feedbackAuthor(comment)));
}

/**
 * Feedback that never needs a model assessment: deleted items, the worker's own items, configured
 * authors, items without a body and configured no-findings verdicts. Requested changes always count.
 */
function ignoredFeedback(value: GitHubEvidence, policy: FeedbackPolicy): boolean {
  if (value.deleted) return true;
  if (policy.automatedReviewSettled && botAuthor(value)) return true;
  if (String(value.state).toUpperCase() === "CHANGES_REQUESTED") return false;
  const author = feedbackAuthor(value);
  if (hasGitHubLogin(policy.workerAuthors, author) || hasGitHubLogin(policy.ignoreFeedbackAuthors, author)) return true;
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

/**
 * The base branch an assessment applies to. Its commit is left out: the base advances with every
 * merge, and conflicts and required checks already gate the merge, so a moving base must not reopen
 * every review. `legacy` reproduces the identities stored before this change, which still match.
 */
function mergeTarget(snapshot: Snapshot, legacy = false) {
  const base = snapshot.pr?.base;
  if (!base) return base;
  // Exclude transport metadata and repository counters from the target identity.
  const repository = (base.repo?.full_name ?? snapshot.repository).toLowerCase();
  return legacy ? { sha: base.sha, ref: base.ref, repository } : { ref: base.ref, repository };
}

/** Assessment is bound to full feedback bodies and failed check evidence, never prose heuristics. */
export function mergeReviewEvidenceKey(snapshot: Snapshot, policy: FeedbackPolicy = {}, legacy = false): string {
  const head = snapshot.pr?.head?.sha;
  const failures = [...Object.values(snapshot.checks), ...Object.values(snapshot.statuses)]
    .filter(value => !value.deleted && (value.head_sha ?? value.sha) === head && !isBabysitterCheckRun(value)
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
    base: mergeTarget(snapshot, legacy),
    comments: feedback(snapshot.comments, policy, false), reviews: feedback(snapshot.reviews, policy),
    reviewComments: feedback(snapshot.reviewComments, policy), threads, failures })).digest("hex");
}

/** Whether a stored evidence key covers this snapshot, including a key stored with the base commit. */
export function matchesMergeReviewEvidence(key: unknown, snapshot: Snapshot, policy: FeedbackPolicy = {}): boolean {
  return hasRuntimeType(key, "string") && (key === mergeReviewEvidenceKey(snapshot, policy) || key === mergeReviewEvidenceKey(snapshot, policy, true));
}

/**
 * Identities of the feedback items that need an assessment. An explicit assessment covers
 * the items it saw on the same merge target. A new base repository or ref needs reassessment,
 * while a later head or base commit on the same target only needs a pass for feedback that arrived since.
 */
export function feedbackFingerprints(snapshot: Snapshot, policy: FeedbackPolicy = {}, legacy = false): string[] {
  const kinds: Array<[string, FeedbackItem[]]> = [["comment", feedback(snapshot.comments, policy, false)],
    ["review", feedback(snapshot.reviews, policy)], ["review-comment", feedback(snapshot.reviewComments, policy)]];
  const target = mergeTarget(snapshot, legacy);
  return kinds.flatMap(([kind, values]) => values.map(value =>
    createHash("sha256").update(JSON.stringify([target, kind, value.id, value.body, value.state])).digest("hex").slice(0, 32)));
}

/** Author and reviewer associations that GitHub gives to people with write access to the repository. */
const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const hasWriteAccess = (association: unknown) => writeAccess.has(String(association ?? "").toUpperCase());

/**
 * The `"approved-if-outside"` merge gate. Each write-access reviewer's latest APPROVED or
 * CHANGES_REQUESTED review counts; comments, pending and dismissed reviews leave it standing.
 */
export function approvedIfOutside({ head, snapshot }: BabysitterMergeReadinessInput): true | string {
  const pr = snapshot.pr;
  if (hasWriteAccess(pr?.author_association ?? pr?.authorAssociation)) return true;
  const latest = new Map<string, GitHubEvidence>();
  const decisive = Object.values(snapshot.reviews)
    .filter(review => !review.deleted && hasWriteAccess(review.author_association ?? review.authorAssociation)
      && ["APPROVED", "CHANGES_REQUESTED"].includes(String(review.state ?? "").toUpperCase()))
    .sort((a, b) => String(a.submitted_at ?? a.submittedAt ?? "").localeCompare(String(b.submitted_at ?? b.submittedAt ?? "")));
  for (const review of decisive) {
    const reviewer = feedbackAuthor(review);
    if (reviewer) latest.set(reviewer, review);
  }
  const short = head.slice(0, 7);
  const blocking = [...latest].filter(([, review]) => String(review.state).toUpperCase() === "CHANGES_REQUESTED").map(([reviewer]) => reviewer);
  if (blocking.length) return `a maintainer's approval of ${short}: ${blocking.join(", ")} requested changes`;
  const approved = [...latest.values()].some(review => (review.commit_id ?? review.commit?.oid) === head);
  return approved || `a maintainer's approval of ${short}`;
}

export function resolveBabysitterMerge(merge: unknown): ResolvedBabysitterMerge {
  if (merge === false) return { mode: "off" };
  if (merge === "auto") return { mode: "auto" };
  if (merge === "direct") return { mode: "direct", method: "squash", ready: approvedIfOutside };
  if (isRuntimeRecord(merge) && merge.strategy === "direct") {
    const method = merge.method ?? "squash";
    if (method !== "squash" && method !== "merge" && method !== "rebase") {
      throw new TypeError('[vitehub] Babysitter merge.method must be "squash", "merge", or "rebase".');
    }
    if (merge.ready !== undefined && merge.ready !== "approved-if-outside" && !hasRuntimeType(merge.ready, "function")) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "merge.ready", expected: 'a function or "approved-if-outside"' });
    }
    const drafts = merge.markDraftsReady;
    if (drafts !== undefined && (!Array.isArray(drafts) || !drafts.every(login => hasRuntimeType(login, "string") && login.trim()))) {
      throw presetsErrorDiagnostics.PRESETS_MERGE_DRAFT_AUTHORS_INVALID();
    }
    // SAFETY: the guard above proves ready is undefined, the built-in policy name, or a function with the documented contract.
    const ready = merge.ready === undefined || merge.ready === "approved-if-outside" ? approvedIfOutside : merge.ready as BabysitterMergeReady;
    return { mode: "direct", method, ready,
      ...drafts?.length ? { markDraftsReady: new Set(drafts.map(login => login.trim().toLowerCase())) } : {} };
  }
  throw new TypeError('[vitehub] Babysitter merge must be false, "auto", "direct", or { strategy: "direct" }.');
}

/** The current-head check runs and statuses retained in an inbox snapshot. */
export function snapshotCheckEvidence(snapshot: Snapshot): GitHubCheckEvidence {
  const head = snapshot.pr?.head?.sha ?? "";
  const checkRuns = Object.values(snapshot.checks).flatMap((check) => {
    if (check.deleted || check.head_sha !== head || isBabysitterCheckRun(check) || !hasRuntimeType(check.id, "number") || !hasRuntimeType(check.name, "string")) return [];
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
  const settled = assessment.automatedReviewSettled === true;
  if (!settled && (evidence.checkRuns.some(check => reviewChecks.has(check.name.toLowerCase()) && pending.has(check.status.toLowerCase()))
    || evidence.statuses.some(status => reviewChecks.has(status.context.toLowerCase()) && pending.has(status.state.toLowerCase())))) {
    return no("a current-head review is still running");
  }
  const failedChecks = evidence.checkRuns.some(check => failing.has(String(check.conclusion).toLowerCase()) && !(settled && reviewChecks.has(check.name.toLowerCase())))
    || evidence.statuses.some(status => failing.has(status.state.toLowerCase()) && !(settled && reviewChecks.has(status.context.toLowerCase())));
  const assessed = assessment.assessedFeedback ?? new Set<string>();
  const legacyFingerprints = feedbackFingerprints(snapshot, assessment, true);
  const unassessed = feedbackFingerprints(snapshot, assessment).filter((id, index) => !assessed.has(id) && !assessed.has(legacyFingerprints[index] ?? "")).length;
  if ((failedChecks || unassessed) && !matchesMergeReviewEvidence(assessment.reviewedEvidenceKey, snapshot, assessment)) {
    return no(failedChecks ? "current-head failures need assessment" : `${unassessed} new feedback item${unassessed === 1 ? " needs" : "s need"} assessment`);
  }
  if (!snapshot.threadsHydrated) return no("review threads not loaded");
  const botThreadsSettled = settled || assessment.ignoreAssessedBotThreads === true;
  if (snapshot.threads.some((thread) => thread.isResolved !== true && (!botThreadsSettled || hasHumanComment(thread, assessment.workerAuthors)))) return no("unresolved review threads");
  return { ready: true, head };
}

/** GitHub's live PR must agree immediately before the merge. */
export function liveMergeReadiness(live: unknown, head: string, reviewPolicy: { automatedReviewSettled?: boolean; reviews?: readonly GitHubEvidence[] } = {}): MergeDecision {
  if (!isRuntimeRecord(live)) return no("pull request unavailable");
  const liveHead = isRuntimeRecord(live.head) ? live.head.sha : undefined;
  const base = isRuntimeRecord(live.base) ? live.base : undefined;
  const repository = base && isRuntimeRecord(base.repo) ? base.repo : undefined;
  if (String(live.state).toLowerCase() !== "open") return no("pull request is no longer open");
  if (liveHead !== head) return no("head changed");
  if (live.draft === true) return no("draft");
  if (live.mergeable === false) return no("merge conflict");
  const reviewDecision = String(live.reviewDecision ?? "").toUpperCase();
  if (reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED") {
    // Once the review push budget is spent, a bot-only change request may be stale.
    // REVIEW_REQUIRED is GitHub's aggregate branch-protection decision, however, and
    // the REST review list cannot prove that its required human approval is stale.
    const reviews = reviewPolicy.reviews ?? [];
    const humanChangesRequested = reviews.some(review => !isAutomatedFeedback(review) && String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED");
    if (reviewDecision === "REVIEW_REQUIRED" || !reviewPolicy.automatedReviewSettled || humanChangesRequested || reviews.length === 0) {
      return no("required review not satisfied");
    }
  }
  // A stacked PR keeps its old base after the parent merges when merged branches are kept.
  // Merging it there would strand the change outside the default branch.
  const defaultBranch = repository?.default_branch;
  if (!hasRuntimeType(defaultBranch, "string") || base?.ref !== defaultBranch) return no(`base ${String(base?.ref ?? "unknown")} is not the default branch`);
  // GitHub uses "unstable" for failing optional checks. The required-check policy and
  // explicit assessment already gate those; GitHub still enforces branch rules atomically.
  if (live.mergeable_state !== "clean" && live.mergeable_state !== "unstable") return no(`mergeable_state ${String(live.mergeable_state ?? "unknown")}`);
  return { ready: true, head };
}
