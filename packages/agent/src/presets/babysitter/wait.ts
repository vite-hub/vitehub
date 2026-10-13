import { createHash } from "node:crypto";
import type { GitHubEvidence, PullRequestWait, Snapshot } from "../../server/github-inbox.ts";
import type { GitHubRequiredCheckState } from "../../server/github-required-checks.ts";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pending = new Set(["queued", "in_progress", "pending", "waiting", "requested", "rerequested", "created"]);
const failed = new Set(["failure", "error", "timed_out", "action_required", "startup_failure"]);

export interface BabysitterWaitPolicy {
  /** Logins whose comments and reviews come from this host's repairs. They never wake a wait. */
  workerAuthors: ReadonlySet<string>;
  /** Configured logins, such as deployment preview bots, whose items never wake a wait. */
  ignoreFeedbackAuthors?: ReadonlySet<string>;
  /** Check names whose pending run means a review is in progress. */
  pendingReviewChecks: ReadonlySet<string>;
  /** Wake when required checks pass, so the host can merge a ready PR. */
  wakeWhenReady: boolean;
  /** Body prefixes of reviews that report no findings. Such reviews never wake a wait. */
  noFindingsReviews: readonly string[];
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

type ContextPolicy = Pick<BabysitterWaitPolicy, "workerAuthors" | "ignoreFeedbackAuthors" | "noFindingsReviews">;

/**
 * A comment-only review that asks for nothing. An empty body only groups inline comments, which the
 * context keeps. A review bot can submit that empty review first and edit it to a no-findings verdict.
 */
function withoutFindings(review: GitHubEvidence, policy: ContextPolicy): boolean {
  if (String(review.state ?? "").toLowerCase() !== "commented") return false;
  const body = hasRuntimeType(review.body, "string") ? review.body.trimStart() : "";
  return !body || policy.noFindingsReviews.some(prefix => body.startsWith(prefix));
}

/** Feedback, intent, and base that need a model pass when they change. CI results are excluded. */
export function repairContextKey(s: Snapshot, policy: ContextPolicy): string {
  const pr = s.pr;
  const fromWorker = (value: GitHubEvidence) => String(value.state).toUpperCase() !== "CHANGES_REQUESTED" && (policy.workerAuthors.has(login(value)) || policy.ignoreFeedbackAuthors?.has(login(value)) === true);
  const external = (values: Record<string, GitHubEvidence>) => Object.fromEntries(Object.entries(values).filter(([, value]) => !fromWorker(value)));
  const reviews = Object.fromEntries(Object.entries(external(s.reviews)).filter(([, value]) => !withoutFindings(value, policy)));
  const ownCommentIds = new Set(Object.values(s.reviewComments).filter(fromWorker).flatMap(commentIds));
  const threads = s.threads.map((thread) => {
    const { isResolved: _resolved, node_id, comments, ...metadata } = thread;
    const items: GitHubEvidence[] = Array.isArray(comments) ? comments : comments?.nodes ?? [];
    // Hydration supplies GraphQL comment IDs and a resolution webhook supplies REST IDs. Both identify the same comment.
    const identities = items.filter(value => !fromWorker(value) && !commentIds(value).some(id => ownCommentIds.has(id))).map(commentIds).sort();
    return { ...metadata, id: node_id ?? thread.id, comments: identities };
  });
  return hash({ title: pr?.title, body: pr?.body, draft: pr?.draft, state: pr?.state, base: [pr?.base?.sha, pr?.base?.ref],
    comments: stableFeedback(external(s.comments)), reviews: stableFeedback(reviews),
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
    signals.set(`status:${String(status.context)}`, { ...status, name: status.context, status: status.state, conclusion: status.state });
  }
  return [...signals.values()];
}

/**
 * The newest run of each current-head check, by name and app. Some integrations leave an earlier
 * run in progress forever and report the result in a later run; the earlier run is not a gate.
 */
export function latestCheckSignals(s: Snapshot): GitHubEvidence[] {
  const latest = new Map<string, GitHubEvidence>();
  for (const signal of currentCheckSignals(s)) {
    const key = `${String(signal.name)}\0${String(signal.app?.id ?? "")}`;
    const previous = latest.get(key);
    if (!previous || Number(signal.id ?? 0) >= Number(previous.id ?? 0)) latest.set(key, signal);
  }
  return [...latest.values()];
}

/** A configured review check still runs on the current head. */
export function reviewCheckRunning(s: Snapshot, policy: Pick<BabysitterWaitPolicy, "pendingReviewChecks">): boolean {
  return latestCheckSignals(s).some(signal => policy.pendingReviewChecks.has(String(signal.name).toLowerCase())
    && pending.has(String(signal.status ?? signal.state)));
}

export function failureKeys(s: Snapshot): string[] {
  return latestCheckSignals(s).filter(signal => failed.has(String(signal.conclusion ?? signal.state)))
    .map(signal => `${String(signal.id ?? signal.context)}:${String(signal.conclusion ?? signal.state)}`).sort();
}

/** The wait that a pass parks on: feedback the model saw and failures it already knew. */
export function createCheckWait(observed: Snapshot, policy: ContextPolicy): Omit<PullRequestWait, "headSha"> {
  return { reason: "checks", evidenceKey: repairContextKey(observed, policy), knownFailures: failureKeys(observed) };
}

/**
 * Decides whether new events on a parked PR still need no model pass. This only suppresses
 * passes; it never authorizes a merge.
 */
export function shouldKeepWaiting(s: Snapshot, requiredChecks: GitHubRequiredCheckState, policy: BabysitterWaitPolicy): boolean {
  return wakeReasons(s, requiredChecks, policy).length === 0;
}

/** Why a parked PR needs a model pass or a direct merge. Empty means it keeps waiting. */
export function wakeReasons(s: Snapshot, requiredChecks: GitHubRequiredCheckState, policy: BabysitterWaitPolicy): string[] {
  const wait = s.wait;
  if (!wait) return ["no-wait"];
  if (s.pr?.state !== "open") return ["not-open"];
  // The synchronize event for a pushed head has not arrived yet.
  if (wait.headSha !== s.pr.head?.sha) return [];
  const known = new Set(wait.knownFailures ?? []);
  if (wait.defer === "checks") {
    // A deferred pass waits for running gates, so one pass handles CI and review results together.
    // A conflict or a new failure needs repair now. The deferral recorded no assessment, so the PR
    // wakes when its gates stop running.
    const conflict = s.pr.mergeable === false || s.pr.mergeable_state === "dirty";
    const failure = failureKeys(s).some(key => !known.has(key));
    if (!conflict && !failure && (reviewCheckRunning(s, policy) || requiredChecks === "pending")) return [];
    return [...conflict ? ["merge-conflict"] : [], ...failure ? ["new-failure"] : [], ...conflict || failure ? [] : ["gates-settled"]];
  }
  const reasons: string[] = [];
  if (wait.evidenceKey !== repairContextKey(s, policy)) reasons.push("feedback-changed");
  // A reproduced external blocker keeps existing conflicts, threads and unrelated CI parked.
  // Maintainer feedback or PR intent/base changes still resume the work.
  if (wait.kind === "external" || wait.wake) return reasons;
  if (s.pr.mergeable === false || s.pr.mergeable_state === "dirty") reasons.push("merge-conflict");
  if (s.threads.some(thread => thread.isResolved !== true)) reasons.push("unresolved-thread");
  if (failureKeys(s).some(key => !known.has(key))) reasons.push("new-failure");
  if (reasons.length) return reasons;
  // The same failures are not new repair work. A later green result wakes below.
  if (requiredChecks === "failed") return [];
  if (reviewCheckRunning(s, policy) || requiredChecks === "pending") return [];
  if (requiredChecks === "passed") return policy.wakeWhenReady ? ["ready-to-merge"] : [];
  // Unknown policy cannot prove readiness. Feedback and new failures still wake the PR.
  return [];
}

/** Infer a check wait only from pending current-head provider evidence. */
export function hasPendingChecks(snapshot: Snapshot, _policy: BabysitterWaitPolicy): boolean {
  return latestCheckSignals(snapshot).some(signal => pending.has(String(signal.status ?? signal.state)));
}

/** The reader paginates and projects individual records from every REST page. */
export async function checksDependencyEvidence(wake: { repository: string; headSha: string }, read: (path: string, projection: string) => Promise<unknown[]>) {
  const checks = await read(`repos/${wake.repository}/commits/${wake.headSha}/check-runs?per_page=100`, ".check_runs[]");
  const statuses = await read(`repos/${wake.repository}/commits/${wake.headSha}/statuses?per_page=100`, ".[]");
  return hash({
    checks: checks.map(check => {
      if (!isRuntimeRecord(check)) throw new Error("Invalid dependency check evidence.");
      return JSON.stringify([check.id, check.status, check.conclusion]);
    }).sort(),
    statuses: statuses.map(status => {
      if (!isRuntimeRecord(status)) throw new Error("Invalid dependency status evidence.");
      return JSON.stringify([status.id, status.context, status.state]);
    }).sort(),
  });
}
