import { describe, expect, it } from "vitest";
import { PullRequestInbox, type Snapshot } from "../src/babysitter/inbox/store.ts";
import { checksStillRunning, createCheckWait, dailyPassExemption, hasPendingChecks, pushCause, reviewCheckRunning, reviewPushBudgetWork, shouldKeepWaiting, wakeReasons, type BabysitterWaitPolicy } from "../src/babysitter/wait.ts";
import { snapshotCheckEvidence } from "../src/babysitter/merge.ts";
import { stackRetargetBase } from "../src/babysitter/stack.ts";
import { evaluateGitHubRequiredChecks } from "../../agent/src/server/github-required-checks.ts";

const repository = "acme/app";
const head = "a".repeat(40);
const policy: BabysitterWaitPolicy = { workerAuthors: new Set(["repair-bot[bot]"]), pendingReviewChecks: new Set(["review-bot"]), wakeWhenReady: false, noFindingsReviews: ["> ✅ No new issues found."] };

async function parked(update: (snapshot: Snapshot) => void = () => {}): Promise<Snapshot> {
  const inbox = new PullRequestInbox({ path: ":memory:", repositories: [repository] });
  try {
    await inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix" }, base: { ref: "main" }, updated_at: "2026-10-01T00:00:00Z" });
    const snapshot = structuredClone((await inbox.claim(1))[0]!.snapshot);
    snapshot.threadsHydrated = true;
    snapshot.checks = { "check_run:1": { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } };
    snapshot.wait = { headSha: head, ...createCheckWait(snapshot, policy) };
    update(snapshot);
    return snapshot;
  } finally { await inbox.close(); }
}

describe("Babysitter check waits", () => {
  it("keeps waiting for known failures and pending checks", async () => {
    expect(shouldKeepWaiting(await parked(), "failed", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "pending", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "unknown", policy)).toBe(true);
  });

  it("wakes for new feedback, a new failure, a conflict, or an unresolved thread", async () => {
    const comment = { id: 9, body: "Please fix", user: { login: "reviewer" } };
    expect(shouldKeepWaiting(await parked(s => { s.comments["9"] = comment }), "pending", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } }), "failed", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.pr!.mergeable_state = "dirty" }), "pending", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.threads = [{ id: "T1", isResolved: false, comments: [] }] }), "pending", policy)).toBe(false);
  });

  it("names every reason a parked PR wakes", async () => {
    expect(wakeReasons(await parked(), "pending", policy)).toEqual([]);
    const snapshot = await parked(s => {
      s.comments["9"] = { id: 9, body: "Please fix", user: { login: "reviewer" } };
      s.threads = [{ id: "T1", isResolved: false, comments: [] }];
      s.pr!.mergeable_state = "dirty";
      s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } };
    });
    expect(wakeReasons(snapshot, "failed", policy)).toEqual(["feedback-changed", "merge-conflict", "unresolved-thread", "new-failure"]);
    expect(wakeReasons(await parked(), "passed", { ...policy, wakeWhenReady: true })).toEqual(["ready-to-merge"]);
    expect(wakeReasons(await parked(s => { delete s.wait }), "pending", policy)).toEqual(["no-wait"]);
  });

  it("ignores feedback from the worker's own identity", async () => {
    const own = { id: 10, body: "Repair pushed", user: { login: "repair-bot[bot]" } };
    expect(shouldKeepWaiting(await parked(s => { s.comments["10"] = own }), "pending", policy)).toBe(true);
  });

  it("keeps waiting through an empty review and its no-findings verdict", async () => {
    // A review bot submits an empty comment-only review, then edits it to its verdict.
    const review = { id: 11, state: "COMMENTED", body: "", user: { login: "review-bot[bot]" } };
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = review }), "pending", policy)).toBe(true);
    const verdict = { ...review, body: "> ✅ No new issues found.\n\n**Reviewed changes**\n\nOne commit." };
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = verdict }), "pending", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = verdict }), "pending", { ...policy, noFindingsReviews: [] })).toBe(false);
  });

  it("wakes for reviews that report findings or request changes", async () => {
    for (const review of [
      { id: 12, state: "COMMENTED", body: "> [!IMPORTANT]\n> This PR leaves two lifecycle gaps.", user: { login: "review-bot[bot]" } },
      { id: 13, state: "CHANGES_REQUESTED", body: "", user: { login: "dev" } },
      { id: 14, state: "COMMENTED", body: "Please split this module. > ✅ No new issues found.", user: { login: "reviewer" } },
    ]) {
      expect(shouldKeepWaiting(await parked(s => { s.reviews[String(review.id)] = review }), "pending", policy)).toBe(false);
    }
  });

  it("wakes a ready PR only when the host can merge it", async () => {
    expect(shouldKeepWaiting(await parked(), "passed", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "passed", { ...policy, wakeWhenReady: true })).toBe(false);
  });

  it("waits while a configured review check runs", async () => {
    const reviewing = (status: string) => parked(s => { s.checks["check_run:3"] = { id: 3, name: "review-bot", head_sha: head, status, app: { id: 6 } } });
    expect(shouldKeepWaiting(await reviewing("in_progress"), "passed", { ...policy, wakeWhenReady: true })).toBe(true);
    expect(shouldKeepWaiting(await reviewing("completed"), "passed", { ...policy, wakeWhenReady: true })).toBe(false);
  });

  it("keeps a pushed-head wait until that head's synchronize event arrives", async () => {
    expect(shouldKeepWaiting(await parked(s => { s.wait = { ...s.wait!, headSha: "b".repeat(40) } }), "unknown", policy)).toBe(true);
  });

  it("infers waits from check evidence rather than result prose", async () => {
    expect(hasPendingChecks(await parked(), policy)).toBe(false);
    expect(hasPendingChecks(await parked(s => { s.checks["queued"] = { id: 8, name: "test", status: "queued", head_sha: head, app: { id: 5 } } }), policy)).toBe(true);
  });
  it.each(["failure", "in_progress"])("ignores superseded %s runs when recording and waking waits", async state => {
    const snapshot = await parked(s => {
      s.checks = {};
      s.wait = { headSha: head, ...createCheckWait(s, policy) };
      s.checks.old = { id: 1, name: "lint", head_sha: head, status: state === "failure" ? "completed" : state, conclusion: state === "failure" ? state : null, app: { id: 5 } };
      s.checks.new = { id: 2, name: "lint", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } };
    });
    expect(createCheckWait(snapshot, policy).knownFailures).toEqual([]);
    expect(hasPendingChecks(snapshot, policy)).toBe(false);
    expect(wakeReasons(snapshot, "pending", policy)).toEqual([]);
    snapshot.wait!.defer = "checks";
    // Nothing runs on the head, so a deferral wakes even while the required-check policy reads pending.
    expect(wakeReasons(snapshot, "pending", policy)).toEqual(["gates-settled"]);
    expect(wakeReasons(snapshot, "passed", policy)).toEqual(["gates-settled"]);
  });

  it("holds reproduced manual blockers through green checks and existing threads", async () => {
    const snapshot = await parked(s => { s.threads = [{ id: "T1", isResolved: false, comments: [] }]; });
    const checkWait = createCheckWait(snapshot, policy);
    snapshot.wait = { headSha: head, ...checkWait, kind: "external", reason: "Credential denied; maintainer must restore service access" };
    expect(wakeReasons(snapshot, "passed", { ...policy, wakeWhenReady: true })).toEqual([]);
    snapshot.checks["new"] = { id: 55, name: "optional", status: "completed", conclusion: "failure", head_sha: head, app: { id: 5 } };
    expect(wakeReasons(snapshot, "failed", policy)).toEqual([]);
    snapshot.comments["manual"] = { id: 56, body: "Service access restored, please retry", user: { login: "dev" } };
    expect(wakeReasons(snapshot, "passed", policy)).toEqual(["feedback-changed"]);
  });
  it("holds a deferred pass while checks run, then wakes once they settle", async () => {
    const deferred = (update: (snapshot: Snapshot) => void = () => {}) => parked(s => {
      s.checks = { "check_run:1": { id: 1, name: "lint", head_sha: head, status: "in_progress", app: { id: 5 } } };
      s.wait = { headSha: head, ...createCheckWait(s, policy), defer: "checks" };
      update(s);
    });
    const feedback = (s: Snapshot) => { s.comments["9"] = { id: 9, body: "Please fix", user: { login: "reviewer" } } };
    const settled = (s: Snapshot) => { s.checks["check_run:1"] = { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } } };
    const failed = (s: Snapshot) => { s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } };
    expect(wakeReasons(await deferred(feedback), "pending", policy)).toEqual([]);
    expect(wakeReasons(await deferred(s => { settled(s); s.checks["check_run:3"] = { id: 3, name: "review-bot", head_sha: head, status: "in_progress", app: { id: 6 } } }), "passed", policy)).toEqual([]);
    expect(wakeReasons(await deferred(s => { s.pr!.mergeable_state = "dirty" }), "pending", policy)).toEqual(["merge-conflict"]);
    // A fast failure waits for the checks that still run, so one pass sees every result.
    expect(wakeReasons(await deferred(failed), "pending", policy)).toEqual([]);
    expect(wakeReasons(await deferred(s => { failed(s); settled(s) }), "failed", policy)).toEqual(["new-failure"]);
    // The deferral recorded no assessment, so it wakes without new evidence once the checks stop.
    expect(wakeReasons(await deferred(s => { feedback(s); settled(s) }), "passed", policy)).toEqual(["gates-settled"]);
    expect(wakeReasons(await deferred(settled), "unknown", policy)).toEqual(["gates-settled"]);
  });

  it("treats a check that runs for half an hour as stuck", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const running = (startedAt: string) => parked(s => {
      s.checks = { "check_run:1": { id: 1, name: "ci", head_sha: head, status: "in_progress", started_at: startedAt, app: { id: 5 } } };
    });
    expect(checksStillRunning(await running("2026-10-18T11:45:00Z"), now)).toBe(true);
    expect(checksStillRunning(await running("2026-10-18T11:29:00Z"), now)).toBe(false);
    // A queued check without a start time still runs.
    expect(checksStillRunning(await parked(s => { s.checks = { "check_run:1": { id: 1, name: "ci", head_sha: head, status: "queued", app: { id: 5 } } } }), now)).toBe(true);
    expect(checksStillRunning(await parked(), now)).toBe(false);
  });

  it("ignores an abandoned earlier run of a review check", async () => {
    const review = (id: number, status: string) => ({ id, name: "review-bot", head_sha: head, status, app: { id: 6 } });
    const snapshot = await parked(s => { s.checks["check_run:3"] = review(3, "in_progress"); s.checks["check_run:4"] = review(4, "completed") });
    expect(reviewCheckRunning(snapshot, policy)).toBe(false);
    expect(wakeReasons(snapshot, "passed", { ...policy, wakeWhenReady: true })).toEqual(["ready-to-merge"]);
    snapshot.checks["check_run:5"] = review(5, "queued");
    expect(reviewCheckRunning(snapshot, policy)).toBe(true);
  });

  it("does not wake for configured feedback authors", async () => {
    const preview = { id: 15, body: "Preview deployed", user: { login: "preview[bot]" } };
    const ignoring = { ...policy, ignoreFeedbackAuthors: new Set(["preview[bot]"]) };
    expect(wakeReasons(await parked(s => { s.comments["15"] = preview }), "pending", policy)).toEqual(["feedback-changed"]);
    const snapshot = await parked();
    snapshot.wait = { headSha: head, ...createCheckWait(snapshot, ignoring) };
    snapshot.comments["15"] = preview;
    expect(wakeReasons(snapshot, "pending", ignoring)).toEqual([]);
    snapshot.reviews["16"] = { ...preview, id: 16, state: "CHANGES_REQUESTED" };
    expect(wakeReasons(snapshot, "pending", ignoring)).toEqual(["feedback-changed"]);
  });

  it("holds an external dependency through an unrelated green PR check", async () => {
    expect(wakeReasons(await parked(s => { s.wait!.wake = { kind: "checks", repository, headSha: "b".repeat(40) }; s.wait!.reason = "base CI"; }), "passed", { ...policy, wakeWhenReady: true })).toEqual([]);
  });
});

describe("Babysitter review push budget", () => {
  const budget: BabysitterWaitPolicy = { ...policy, reviewPushBudget: 2 };
  const bot = { login: "pullfrog[bot]", type: "Bot" };
  // A PR that spent its budget parks with the automated-review state it has seen.
  const spent = (update: (snapshot: Snapshot) => void = () => {}, count = 2) => parked(s => {
    s.reviewPushBudget = { count, heads: [head] };
    s.wait = { headSha: head, ...createCheckWait(s, budget) };
    update(s);
  });

  it("stops waking for automated review feedback and review-check failures", async () => {
    expect(wakeReasons(await spent(s => { s.comments["20"] = { id: 20, body: "Consider renaming this.", user: bot } }), "pending", budget)).toEqual([]);
    expect(wakeReasons(await spent(s => { s.reviews["21"] = { id: 21, state: "CHANGES_REQUESTED", body: "Rename it.", user: bot } }), "pending", budget)).toEqual([]);
    expect(wakeReasons(await spent(s => { s.checks["check_run:3"] = { id: 3, name: "review-bot", head_sha: head, status: "completed", conclusion: "failure", app: { id: 6 } } }), "pending", budget)).toEqual([]);
    // GraphQL names an App author by its login and a Bot typename.
    expect(wakeReasons(await spent(s => { s.threads = [{ id: "T2", isResolved: false, comments: [{ id: 22, body: "Nit", author: { login: "pullfrog", __typename: "Bot" } }] }] }), "pending", budget)).toEqual([]);
  });

  it("keeps waking for a person, a conflict, a required failure and work before the budget is spent", async () => {
    expect(wakeReasons(await spent(s => { s.comments["20"] = { id: 20, body: "Consider renaming this.", user: bot } }, 1), "pending", budget)).toEqual(["feedback-changed"]);
    expect(wakeReasons(await spent(s => { s.comments["23"] = { id: 23, body: "Please rename it.", user: { login: "maintainer", type: "User" } } }), "pending", budget)).toEqual(["feedback-changed"]);
    expect(wakeReasons(await spent(s => { s.pr!.mergeable_state = "dirty" }), "pending", budget)).toEqual(["merge-conflict"]);
    expect(wakeReasons(await spent(s => { s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } }), "failed", budget)).toEqual(["new-failure"]);
    expect(wakeReasons(await spent(s => { s.threads = [{ id: "T3", isResolved: false, comments: [{ id: 24, body: "Why?", author: { login: "maintainer", __typename: "User" } }] }] }), "pending", budget)).toEqual(["feedback-changed", "unresolved-thread"]);
    expect(wakeReasons(await spent(), "passed", { ...budget, wakeWhenReady: true })).toEqual(["ready-to-merge"]);
  });

  it("ends a check deferral without a review-check failure counting as new", async () => {
    const deferred = await spent(s => {
      s.wait = { ...s.wait!, defer: "checks" };
      s.checks["check_run:3"] = { id: 3, name: "review-bot", head_sha: head, status: "completed", conclusion: "failure", app: { id: 6 } };
    });
    expect(wakeReasons(deferred, "pending", budget)).toEqual(["gates-settled"]);
  });

  it("counts a push as review-driven only without a conflict or a failure outside the review checks", async () => {
    const reviewed = await parked(s => { s.checks = { "check_run:3": { id: 3, name: "review-bot", head_sha: head, status: "completed", conclusion: "failure", app: { id: 6 } } } });
    expect(pushCause(reviewed, policy)).toBe("review");
    expect(pushCause(await parked(), policy)).toBe("repair");
    expect(pushCause(await parked(s => { s.checks = {}; s.pr!.mergeable_state = "dirty" }), policy)).toBe("repair");
  });

  it("names the work that still needs a model pass after the budget is spent", async () => {
    const clean = (update: (snapshot: Snapshot) => void = () => {}) => spent(s => { s.checks = {}; update(s) });
    expect(reviewPushBudgetWork(await clean(s => { s.comments["20"] = { id: 20, body: "Nit", user: bot } }), budget, new Set())).toEqual([]);
    expect(reviewPushBudgetWork(await clean(s => { s.pr!.mergeable_state = "dirty" }), budget, new Set())).toEqual(["merge-conflict"]);
    expect(reviewPushBudgetWork(await spent(), budget, new Set())).toEqual(["failed-check"]);
    const human = await clean(s => { s.comments["23"] = { id: 23, body: "Please rename it.", user: { login: "maintainer", type: "User" } } });
    expect(reviewPushBudgetWork(human, budget, new Set())).toEqual(["feedback"]);
    expect(reviewPushBudgetWork(await clean(s => { s.threads = [{ id: "T3", isResolved: false, comments: [{ id: 24, body: "Why?", author: { login: "maintainer", __typename: "User" } }] }] }), budget, new Set())).toEqual(["unresolved-thread"]);
    // Someone else moved the head after the budget ran out.
    expect(reviewPushBudgetWork(await clean(s => { s.reviewPushBudget = { count: 2, heads: ["b".repeat(40)] } }), budget, new Set())).toEqual(["new-head"]);
  });
});

describe("Babysitter daily pass budget", () => {
  it("exempts a person's feedback, the first required failure on a head, and a conflict on an otherwise ready PR", async () => {
    const clean = (update: (snapshot: Snapshot) => void = () => {}) => parked(s => { s.checks = {}; update(s) });
    expect(dailyPassExemption(await clean(), "passed", undefined)).toBeUndefined();
    expect(dailyPassExemption(await clean(s => { s.humanFeedbackGeneration = 3 }), "passed", { passes: [], human: 2, exemptions: [] })).toBe("human-feedback");
    expect(dailyPassExemption(await clean(s => { s.humanFeedbackGeneration = 3 }), "passed", { passes: [], human: 3, exemptions: [] })).toBeUndefined();
    expect(dailyPassExemption(await clean(), "failed", undefined)).toBe(`required-failure:${head}`);
    expect(dailyPassExemption(await clean(), "failed", { passes: [], exemptions: [`required-failure:${head}`] })).toBeUndefined();
    const conflict = await clean(s => { s.pr!.mergeable_state = "dirty"; s.pr!.base!.sha = "c".repeat(40) });
    expect(dailyPassExemption(conflict, "passed", undefined)).toBe(`conflict:${head}:${"c".repeat(40)}`);
    expect(dailyPassExemption(conflict, "passed", { passes: [], exemptions: [`conflict:${head}:${"c".repeat(40)}`] })).toBeUndefined();
    // A conflict beside a failing check or an open thread is not an otherwise ready PR.
    expect(dailyPassExemption(await parked(s => { s.pr!.mergeable_state = "dirty" }), "pending", undefined)).toBeUndefined();
    expect(dailyPassExemption(await clean(s => { s.pr!.mergeable_state = "dirty"; s.threads = [{ id: "T1", isResolved: false, comments: [] }] }), "passed", undefined)).toBeUndefined();
  });
});

describe("Babysitter required checks", () => {
  it("matches a required check bound to an app ID", async () => {
    const snapshot = await parked(s => { s.checks = { "check_run:1": { id: 1, name: "test", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } } } });
    const policyFor = (appId: number) => ({ repository, branch: "main", status: "known" as const, source: "github-rest-rules-and-protection" as const,
      fetchedAt: "2026-10-01T00:00:00Z", required: [{ context: "test", appId }] });
    expect(evaluateGitHubRequiredChecks(policyFor(5), snapshotCheckEvidence(snapshot)).state).toBe("passed");
    expect(evaluateGitHubRequiredChecks(policyFor(6), snapshotCheckEvidence(snapshot)).state).toBe("pending");
  });
});

describe("Babysitter stacked PRs", () => {
  const pr = { number: 7, base: { ref: "feat/parent", repo: { full_name: repository, default_branch: "main", owner: { login: "acme" } } } };
  const parent = (state: string, merged: boolean, base: string) => ({ state, merged_at: merged ? "2026-10-01T00:00:00Z" : null, head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: base } });
  it("retargets only after the parent merged into the default branch", () => {
    expect(stackRetargetBase(pr, [parent("closed", true, "main")])).toBe("main");
    expect(stackRetargetBase(pr, [parent("open", false, "main")])).toBeUndefined();
    expect(stackRetargetBase(pr, [parent("closed", false, "main")])).toBeUndefined();
    expect(stackRetargetBase(pr, [parent("closed", true, "feat/grandparent")])).toBeUndefined();
    expect(stackRetargetBase({ ...pr, base: { ...pr.base, ref: "main" } }, [parent("closed", true, "main")])).toBeUndefined();
  });
});
