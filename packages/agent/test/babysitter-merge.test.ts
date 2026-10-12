import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/server/github-inbox.ts";
import { directMergeReadiness, feedbackFingerprints, liveMergeReadiness, mergeReviewEvidenceKey, snapshotCheckEvidence } from "../src/presets/babysitter/merge.ts";
import { directMergeBranchSafety, stackRetargetBase } from "../src/presets/babysitter/stack.ts";

const head = "a".repeat(40);
function snapshot(): Snapshot {
  return {
    repository: "acme/app", number: 12,
    pr: { number: 12, state: "open", draft: false, title: "Fix bug", body: "Details",
      head: { sha: head, ref: "fix", repo: { full_name: "acme/app" } },
      base: { sha: "c".repeat(40), ref: "main", repo: { full_name: "acme/app", default_branch: "main" } } },
    generation: 1, handled: 0, dirtyAt: 1, nextAt: 0, status: "ready", lease: null, leaseUntil: 0,
    attempts: 0, hydrated: true, refresh: false, feedbackRefresh: false, comments: {}, reviews: {},
    reviewComments: {}, checks: {}, statuses: {}, threads: [], threadsHydrated: true, reasons: [],
  };
}

describe("Babysitter merge evidence", () => {
  it("compares base repository identity without transport counters or owner metadata", () => {
    const s = snapshot(), original = mergeReviewEvidenceKey(s);
    s.pr!.base!.repo = { ...s.pr!.base!.repo!, pushed_at: "2026-10-08T20:00:00Z", size: 12345, open_issues_count: 20, owner: { login: "acme", avatar_url: "https://example.test/new-avatar" } };
    expect(mergeReviewEvidenceKey(s)).toBe(original);
    s.pr!.base!.repo!.full_name = "another/app";
    expect(mergeReviewEvidenceKey(s)).not.toBe(original);
  });

  it("allows optional pending checks and statuses after authoritative required checks pass", () => {
    const s = snapshot();
    s.checks.optional = { id: 1, name: "optional", head_sha: head, status: "in_progress", app: { id: 1 } };
    s.statuses.optional = { context: "optional-status", sha: head, state: "pending" };
    expect(directMergeReadiness(s, "passed")).toEqual({ ready: true, head });
    expect(directMergeReadiness(s, "pending").ready).toBe(false);
    expect(directMergeReadiness(s, "unknown").ready).toBe(false);
  });

  it("waits only for configured active current-head reviews", () => {
    const s = snapshot();
    s.checks.review = { id: 1, name: "Pullfrog", head_sha: head, status: "in_progress", app: { id: 1 } };
    const policy = { pendingReviewChecks: new Set(["pullfrog"]) };
    expect(directMergeReadiness(s, "passed", policy)).toEqual({ ready: false, reason: "a current-head review is still running" });
    s.checks.review.head_sha = "b".repeat(40);
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(true);
    s.statuses.review = { context: "pullfrog", sha: head, state: "pending" };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(false);
  });

  it("requires explicit assessment for findings in a review body without inline threads", () => {
    const s = snapshot();
    s.reviews.review = { id: 3, state: "COMMENTED", commit_id: head, body: "The fallback drops customer records." };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
    const reviewedEvidenceKey = mergeReviewEvidenceKey(s);
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey })).toEqual({ ready: true, head });
    s.reviews.review.body += " Also check concurrency.";
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(false);
  });

  it("does not infer an approval from prose containing success words", () => {
    const s = snapshot();
    s.comments.comment = { id: 4, body: "Approved overall, but the success path loses data." };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
  });

  it("ignores repair markers only from the verified host identity", () => {
    const s = snapshot();
    const policy = { workerAuthors: new Set(["repair[bot]"]) };
    s.comments.comment = { id: 4, body: "<!-- vitehub-babysitter-repair:repair -->\nFinding", user: { login: "outsider" } };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(false);
    s.comments.comment.user = { login: "repair[bot]" };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(true);
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
  });

  it("requires failure assessment and invalidates it when failure details or head change", () => {
    const s = snapshot();
    s.checks.optional = { id: 5, name: "optional", head_sha: head, status: "completed", conclusion: "failure", output: { summary: "runner unavailable" } };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
    const reviewedEvidenceKey = mergeReviewEvidenceKey(s);
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(true);
    s.checks.optional.output = { summary: "assertion failed" };
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(false);
    s.pr!.head!.sha = "b".repeat(40);
    expect(mergeReviewEvidenceKey(s)).not.toBe(reviewedEvidenceKey);
  });

  it("preserves assessment across CI success and thread resolution transport metadata", () => {
    const s = snapshot();
    s.reviews.review = { id: 3, body: "Reviewed", state: "APPROVED", updated_at: "2026-10-01" };
    s.threads = [{ id: "thread", isResolved: true, comments: [{ id: "comment", body: "Finding" }] }];
    const key = mergeReviewEvidenceKey(s);
    s.checks.success = { id: 7, name: "test", head_sha: head, status: "completed", conclusion: "success" };
    s.reviews.review.updated_at = "2026-10-02";
    s.threads[0]!.resolutionObservedAt = "2026-10-02";
    expect(mergeReviewEvidenceKey(s)).toBe(key);
    s.threads[0]!.isResolved = false;
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey: key }).ready).toBe(false);
  });

  const feedbackPolicy = {
    workerAuthors: new Set(["repair[bot]"]),
    ignoreFeedbackAuthors: new Set(["preview[bot]"]),
    noFindingsReviews: ["> ✅ No new issues found."],
  };

  it("merges without an assessment when feedback has no findings", () => {
    const s = snapshot();
    s.reviews.verdict = { id: 1, state: "COMMENTED", body: "> ✅ No new issues found.\n\nReviewed.", user: { login: "review[bot]", type: "Bot" } };
    s.reviews.empty = { id: 2, state: "COMMENTED", body: "", user: { login: "review[bot]", type: "Bot" } };
    s.comments.preview = { id: 3, body: "Preview ready", user: { login: "preview[bot]", type: "Bot" } };
    s.comments.verdict = { id: 4, body: "> ✅ No new issues found.", user: { login: "other[bot]", type: "Bot" } };
    s.reviewComments.own = { id: 5, body: "Fixed in abc123.", user: { login: "repair[bot]", type: "Bot" } };
    expect(directMergeReadiness(s, "passed", feedbackPolicy)).toEqual({ ready: true, head });
    expect(feedbackFingerprints(s, feedbackPolicy)).toEqual([]);
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
  });

  it.each(["maintainer", "preview[bot]", "repair[bot]"])("always counts requested changes from %s, even without a body", (login) => {
    const s = snapshot();
    s.reviews.blocked = { id: 6, state: "CHANGES_REQUESTED", body: "", user: { login, type: "User" } };
    expect(directMergeReadiness(s, "passed", feedbackPolicy)).toEqual({ ready: false, reason: "1 new feedback item needs assessment" });
  });

  it("keeps assessed feedback assessed on later heads and asks only about new items", () => {
    const s = snapshot();
    s.reviews.finding = { id: 7, state: "COMMENTED", body: "P2: handle the empty cursor", user: { login: "review[bot]", type: "Bot" } };
    expect(directMergeReadiness(s, "passed", feedbackPolicy).ready).toBe(false);
    const assessedFeedback = new Set(feedbackFingerprints(s, feedbackPolicy));
    s.pr!.head!.sha = "b".repeat(40);
    expect(directMergeReadiness(s, "passed", { ...feedbackPolicy, assessedFeedback })).toEqual({ ready: true, head: "b".repeat(40) });
    s.reviews.another = { id: 8, state: "COMMENTED", body: "P1: new defect", user: { login: "review[bot]", type: "Bot" } };
    expect(directMergeReadiness(s, "passed", { ...feedbackPolicy, assessedFeedback })).toEqual({ ready: false, reason: "1 new feedback item needs assessment" });
    s.reviews.finding.body += " Also the full cursor.";
    expect(directMergeReadiness(s, "passed", { ...feedbackPolicy, assessedFeedback })).toEqual({ ready: false, reason: "2 new feedback items need assessment" });
  });

  it.each(["repository", "ref", "commit"])("requires renewed feedback assessment after the base %s changes", (target) => {
    const s = snapshot();
    s.reviews.finding = { id: 7, state: "COMMENTED", body: "Handle the empty cursor", user: { login: "review[bot]", type: "Bot" } };
    const assessedFeedback = new Set(feedbackFingerprints(s, feedbackPolicy));
    const reviewedEvidenceKey = mergeReviewEvidenceKey(s, feedbackPolicy);
    const assessment = { ...feedbackPolicy, assessedFeedback, reviewedEvidenceKey };
    expect(directMergeReadiness(s, "passed", assessment).ready).toBe(true);
    if (target === "repository") s.pr!.base!.repo!.full_name = "another/app";
    if (target === "ref") s.pr!.base!.ref = "release";
    if (target === "commit") s.pr!.base!.sha = "d".repeat(40);
    expect(directMergeReadiness(s, "passed", assessment)).toEqual({ ready: false, reason: "1 new feedback item needs assessment" });
    expect(directMergeReadiness(s, "passed", {
      ...assessment, assessedFeedback: new Set(feedbackFingerprints(s, feedbackPolicy)),
    }).ready).toBe(true);
  });

  it("identifies bot issue comments by identity and human comments by body", () => {
    const s = snapshot();
    s.comments.panel = { id: 9, body: "Reviewing…", user: { login: "summary[bot]", type: "Bot" } };
    s.comments.human = { id: 10, body: "Please rename the option.", user: { login: "maintainer", type: "User" } };
    const assessedFeedback = new Set(feedbackFingerprints(s, feedbackPolicy));
    const key = mergeReviewEvidenceKey(s, feedbackPolicy);
    s.comments.panel.body = "Done reviewing";
    expect(mergeReviewEvidenceKey(s, feedbackPolicy)).toBe(key);
    expect(directMergeReadiness(s, "passed", { ...feedbackPolicy, assessedFeedback }).ready).toBe(true);
    s.comments.human.body = "Please rename the option and the type.";
    expect(mergeReviewEvidenceKey(s, feedbackPolicy)).not.toBe(key);
    expect(directMergeReadiness(s, "passed", { ...feedbackPolicy, assessedFeedback }).ready).toBe(false);
  });

  it("uses only the newest run of a rerun check as merge evidence", () => {
    const s = snapshot();
    s.checks["check_run:1"] = { id: 1, name: "ci", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } };
    s.checks["check_run:2"] = { id: 2, name: "ci", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } };
    s.checks["check_run:3"] = { id: 3, name: "ci", head_sha: head, status: "completed", conclusion: "failure", app: { id: 6 } };
    expect(snapshotCheckEvidence(s).checkRuns.map(check => check.id)).toEqual([2, 3]);
    delete s.checks["check_run:3"];
    expect(directMergeReadiness(s, "passed")).toEqual({ ready: true, head });
  });

  it("allows GitHub unstable only after required policy and assessment, and rejects feature bases", () => {
    const s = snapshot();
    const live = { ...s.pr, mergeable: true, mergeable_state: "unstable" };
    expect(liveMergeReadiness(live, head)).toEqual({ ready: true, head });
    expect(liveMergeReadiness({ ...live, reviewDecision: "REVIEW_REQUIRED" }, head).ready).toBe(false);
    expect(liveMergeReadiness({ ...live, mergeable: false }, head).ready).toBe(false);
    expect(liveMergeReadiness({ ...live, base: { ...live.base, ref: "feature" } }, head).ready).toBe(false);
  });
});

describe("Babysitter stacked PR preservation", () => {
  it("keeps parent branches with open children when GitHub automatically deletes merged branches", () => {
    const s = snapshot();
    const children = [{ state: "open", base: { ref: "fix" }, head: { ref: "child" } }];
    expect(directMergeBranchSafety({ delete_branch_on_merge: true }, s.pr, children)).toContain("open child");
    expect(directMergeBranchSafety({ delete_branch_on_merge: false }, s.pr, children)).toBe(true);
    expect(directMergeBranchSafety({}, s.pr, children)).toContain("unavailable");
    expect(children[0]!.base.ref).toBe("fix");
  });

  it("retargets only after the parent has landed on the default branch", () => {
    const s = snapshot();
    s.pr!.base!.ref = "parent";
    s.pr!.base!.repo!.owner = { login: "acme" };
    const parent = { head: { ref: "parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" }, state: "closed", merged_at: "2026-10-01" };
    expect(stackRetargetBase(s.pr!, [parent])).toBe("main");
    expect(stackRetargetBase(s.pr!, [{ ...parent, state: "open" }])).toBeUndefined();
    expect(stackRetargetBase(s.pr!, [{ ...parent, base: { ref: "feature" } }])).toBeUndefined();
  });
});
