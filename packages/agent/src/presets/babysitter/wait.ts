import { createHash } from "node:crypto";
import type { GitHubEvidence, PullRequestWait, Snapshot } from "../../server/github-inbox.ts";
import type { GitHubRequiredCheckState } from "../../server/github-required-checks.ts";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pending = new Set(["queued", "in_progress", "pending", "waiting", "requested", "rerequested", "created"]);
const failed = new Set(["failure", "error", "timed_out", "action_required", "startup_failure", "cancelled", "stale"]);

export interface BabysitterWaitPolicy {
  /** Logins whose comments and reviews come from this host's repairs. They never wake a wait. */
  workerAuthors: ReadonlySet<string>;
  /** Check names whose pending run means a review is in progress. */
  pendingReviewChecks: ReadonlySet<string>;
  /** Wake when required checks pass, so the host can merge a ready PR. */
  wakeWhenReady: boolean;
}

function login(value: GitHubEvidence): string {
  const user: unknown = value.user ?? value.author;
  return isRuntimeRecord(user) && hasRuntimeType(user.login, "string") ? user.login.toLowerCase() : "";
}

function commentIds(value: GitHubEvidence): string[] {
  return [value.id, value.node_id, value.databaseId].filter(id => id !== undefined && id !== null).map(String);
}

/** Webhook replays carry fresh transport metadata. Ignore it, so unchanged feedback keeps a wait. */
function stableFeedback(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFeedback);
  if (!isRuntimeRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["updated_at", "updatedAt", "url", "html_url", "resolutionSource", "resolutionObservedAt"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableFeedback(item)]));
}

/** Feedback, intent, and base that need a model pass when they change. CI results are excluded. */
export function repairContextKey(s: Snapshot, policy: Pick<BabysitterWaitPolicy, "workerAuthors">): string {
  const pr = s.pr;
  const fromWorker = (value: GitHubEvidence) => policy.workerAuthors.has(login(value));
  const external = (values: Record<string, GitHubEvidence>) => Object.fromEntries(Object.entries(values).filter(([, value]) => !fromWorker(value)));
  const ownCommentIds = new Set(Object.values(s.reviewComments).filter(fromWorker).flatMap(commentIds));
  const threads = s.threads.map((thread) => {
    const { isResolved: _resolved, node_id, comments, ...metadata } = thread;
    const items: GitHubEvidence[] = Array.isArray(comments) ? comments : comments?.nodes ?? [];
    // Hydration supplies GraphQL comment IDs and a resolution webhook supplies REST IDs. Both identify the same comment.
    const identities = items.filter(value => !fromWorker(value) && !commentIds(value).some(id => ownCommentIds.has(id))).map(commentIds).sort();
    return { ...metadata, id: node_id ?? thread.id, comments: identities };
  });
  return hash({ title: pr?.title, body: pr?.body, draft: pr?.draft, state: pr?.state, base: [pr?.base?.sha, pr?.base?.ref],
    comments: stableFeedback(external(s.comments)), reviews: stableFeedback(external(s.reviews)),
    reviewComments: stableFeedback(external(s.reviewComments)), threads: stableFeedback(threads) });
}

/** Current-head check runs, without workflow aggregates, and commit statuses. */
export function currentCheckSignals(s: Snapshot): GitHubEvidence[] {
  const head = s.pr?.head?.sha;
  const signals = new Map<string, GitHubEvidence>();
  for (const check of Object.values(s.checks)) {
    // Suites and workflow runs have no producing app; check runs do.
    if (!head || check.head_sha !== head || check.deleted || !check.name || !check.app) continue;
    signals.set(`check:${String(check.id)}`, check);
  }
  for (const status of Object.values(s.statuses)) {
    if (!head || status.sha !== head || status.deleted) continue;
    signals.set(`status:${String(status.context)}`, { ...status, name: status.context, status: status.state, conclusion: status.state, __status: true });
  }
  return [...signals.values()];
}

export function failureKeys(s: Snapshot): string[] {
  return currentCheckSignals(s).filter(signal => failed.has(String(signal.conclusion ?? signal.state)))
    .map(signal => `${signal.__status ? `status:${String(signal.context)}` : `check:${String(signal.id)}`}:${String(signal.conclusion ?? signal.state)}`).sort();
}

/** The wait that a pass parks on: feedback the model saw and failures it already knew. */
export function createCheckWait(observed: Snapshot, policy: Pick<BabysitterWaitPolicy, "workerAuthors">): Omit<PullRequestWait, "headSha"> {
  return { reason: "checks", evidenceKey: repairContextKey(observed, policy), knownFailures: failureKeys(observed) };
}

/**
 * Decides whether new events on a parked PR still need no model pass. This only suppresses
 * passes; it never authorizes a merge.
 */
export function shouldKeepWaiting(s: Snapshot, requiredChecks: GitHubRequiredCheckState, policy: BabysitterWaitPolicy): boolean {
  const wait = s.wait;
  if (!wait || s.pr?.state !== "open") return false;
  // The synchronize event for a pushed head has not arrived yet.
  if (wait.headSha !== s.pr.head?.sha) return true;
  if (wait.evidenceKey !== repairContextKey(s, policy)) return false;
  if (s.pr.mergeable === false || s.pr.mergeable_state === "dirty") return false;
  if (s.threads.some(thread => thread.isResolved !== true)) return false;
  const known = new Set(wait.knownFailures ?? []);
  if (failureKeys(s).some(key => !known.has(key))) return false;
  // The same failures are not new repair work. A later green result wakes below.
  if (requiredChecks === "failed") return true;
  const reviewing = currentCheckSignals(s).some(signal => policy.pendingReviewChecks.has(String(signal.name).toLowerCase())
    && pending.has(String(signal.status ?? signal.state)));
  if (reviewing || requiredChecks === "pending") return true;
  if (requiredChecks === "passed") return !policy.wakeWhenReady;
  // Unknown policy cannot prove readiness. Feedback and new failures still wake the PR.
  return true;
}

const externalWait = [
  /(?:exact[- ]base|unrelated|external|pending|in progress|waiting for|no (?:independent )?repair|cannot (?:start|run)|dependencies.*unavailable)/i,
  /\b(?:ci|checks?|tests?|reviews?)\b[^.!?\n]{0,100}\b(?:queued|running)\b|\bwait for (?:[a-z]+\s+){0,3}webhooks?\b/i,
];

/** A park that names an external gate, such as pending checks or a reproduced blocker. */
export function isExternalWaitResult(text: string): boolean {
  return externalWait.some(pattern => pattern.test(text));
}
