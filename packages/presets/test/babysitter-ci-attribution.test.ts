import { describe, expect, it } from "vitest";
import type { GitHubRequiredCheckPolicy } from "../src/github/index.ts";
import type { Snapshot } from "../src/babysitter/inbox/store.ts";
import { failedOwnActions, inheritedBypassSafety, inheritedCheckEvaluation, jobFailureFacts, parseFailedActionOutput, sameActionFailure, unrelatedFailureWait } from "../src/babysitter/ci-attribution.ts";
import { approvedIfOutside, directMergeReadiness, resolveBabysitterMerge, snapshotCheckEvidence } from "../src/babysitter/merge.ts";
import { missingRequiredChecks } from "../src/babysitter/wait.ts";

const head = "a".repeat(40);
const reviewChecks = new Set(["pullfrog"]);

function snapshot(checks: Record<string, unknown>[] = []): Snapshot {
  return {
    repository: "acme/app", number: 12,
    pr: { number: 12, state: "open", draft: false, head: { sha: head, ref: "fix" }, base: { sha: "c".repeat(40), ref: "main", repo: { full_name: "acme/app", default_branch: "main" } } },
    generation: 1, handled: 0, dirtyAt: 1, nextAt: 0, status: "ready", lease: null, leaseUntil: 0,
    attempts: 0, hydrated: true, refresh: false, feedbackRefresh: false, comments: {}, reviews: {}, reviewComments: {}, statuses: {}, threads: [], threadsHydrated: true, reasons: [],
    checks: Object.fromEntries(checks.map(check => [`check_run:${String(check.id)}`, check])),
  };
}
const run = (id: number, name: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ id, name, head_sha: head, status: conclusion ? "completed" : "in_progress", conclusion,
  app: { slug: "github-actions", id: 15368 }, html_url: `https://github.com/acme/app/actions/runs/${id}/job/${id}`, ...extra });
const policy = (required: string[]): GitHubRequiredCheckPolicy => ({ repository: "acme/app", branch: "main", status: "known", source: "github-rest-rules-and-protection",
  fetchedAt: "2026-11-09T00:00:00Z", required: required.map(context => ({ context, appId: null })) });
const log = (lines: string[], step = "pnpm test") => [`2026-11-09T00:00:00.1234567Z ##[group]Run ${step}`, step, "##[endgroup]", ...lines, "##[error]Process completed with exit code 1."].join("\n");

describe("Babysitter CI attribution", () => {
  it("reads the output of the step that failed, without times and ids", () => {
    const output = parseFailedActionOutput(log(["\u001b[31m FAIL \u001b[39m test/a.test.ts", "Duration  1.25s", "run 3f2a9b1c-0000-4f7e-8b0c-2d5f9a8c1e42 at 10:11:12"]));
    expect(output).toEqual({ step: "##[group]Run pnpm test", lines: new Set([" FAIL  test/a.test.ts", "Duration  <time>", "run <id> at <clock>"]) });
    expect(parseFailedActionOutput("no failed step")).toBeUndefined();
  });

  it("calls a failure inherited only when every failure it names also fails on the base", () => {
    const own = parseFailedActionOutput(log([" FAIL  test/a.test.ts > adds", "Test Files  1 failed | 3 passed (4)"]));
    // vitehub tests only the changed packages on a PR, so the base runs more files.
    expect(sameActionFailure(own, parseFailedActionOutput(log([" FAIL  test/a.test.ts > adds", " FAIL  test/z.test.ts > old", "Test Files  2 failed | 40 passed (42)"])))).toBe(true);
    expect(sameActionFailure(parseFailedActionOutput(log([" FAIL  test/a.test.ts > adds", " FAIL  test/b.test.ts > new"])), parseFailedActionOutput(log([" FAIL  test/a.test.ts > adds"])))).toBe(false);
    // Output that names no failure must match line for line in the same step.
    expect(sameActionFailure(parseFailedActionOutput(log(["Unused files (1)", "src/a.ts"], "pnpm knip")), parseFailedActionOutput(log(["Unused files (1)", "src/a.ts"], "pnpm knip")))).toBe(true);
    expect(sameActionFailure(parseFailedActionOutput(log(["Unused files (2)", "src/a.ts", "src/own.ts"], "pnpm knip")), parseFailedActionOutput(log(["Unused files (1)", "src/a.ts"], "pnpm knip")))).toBe(false);
    expect(sameActionFailure(parseFailedActionOutput(log(["src/a.ts"], "pnpm knip")), parseFailedActionOutput(log(["src/a.ts"], "pnpm lint")))).toBe(false);
    expect(sameActionFailure(own, undefined)).toBe(false);
  });

  it("finds runner and network errors, and gate jobs that only report other jobs", () => {
    expect(jobFailureFacts(log(["##[error]Error: Unexpected HTTP response: 504"]))).toEqual({ infrastructure: "Error: Unexpected HTTP response: 504", gate: false });
    expect(jobFailureFacts("2026-11-09T00:00:00Z ##[error]The runner has received a shutdown signal.")).toMatchObject({ infrastructure: "The runner has received a shutdown signal." });
    expect(jobFailureFacts(log(["Error: connect ECONNREFUSED 127.0.0.1:3000"]))).toEqual({ gate: false });
    expect(jobFailureFacts(log(["package-tests: failure", "lint: success"]))).toEqual({ gate: false });
    expect(jobFailureFacts(log(["package-tests: failure", "e2e: cancelled"]))).toEqual({ gate: true });
  });

  it("parks only when no failure is the PR's, and a gate job follows the jobs of its run", () => {
    const now = 1_000;
    expect(unrelatedFailureWait([{ name: "test", runId: 1, cause: "inherited" }], "main", now)).toEqual({
      reason: "No repair pass: this PR did not cause its failing checks. test fails the same way on main; the host retests this PR when main passes.",
      checks: ["test"], infrastructure: false, retryAt: now + 15 * 60_000 });
    expect(unrelatedFailureWait([{ name: "ci", runId: 1, cause: "pr", gate: true }, { name: "package-tests", runId: 1, cause: "inherited" }], "main", now)?.checks).toEqual(["package-tests"]);
    expect(unrelatedFailureWait([{ name: "ci", runId: 2, cause: "pr", gate: true }, { name: "package-tests", runId: 1, cause: "inherited" }], "main", now)).toBeUndefined();
    expect(unrelatedFailureWait([{ name: "e2e", runId: 1, cause: "infrastructure", line: "HTTP 504" }], "main", now)).toMatchObject({ infrastructure: true, retryAt: now + 60 * 60_000 });
    expect(unrelatedFailureWait([{ name: "e2e", cause: "pr" }, { name: "test", cause: "inherited" }], "main", now)).toBeUndefined();
    expect(unrelatedFailureWait([], "main", now)).toBeUndefined();
  });

  it("counts only the newest own Actions run of each check, outside the review checks", () => {
    expect(failedOwnActions(snapshot([run(1, "check / e2e", "failure"), run(2, "check / check", "success")]), reviewChecks)).toEqual(["check / e2e"]);
    expect(failedOwnActions(snapshot([run(1, "check / e2e", "failure"), run(3, "check / e2e", "success")]), reviewChecks)).toEqual([]);
    expect(failedOwnActions(snapshot([
      run(4, "pullfrog", "failure"),
      run(5, "Workers Builds: app", "failure", { app: { slug: "cloudflare-workers-and-pages" }, html_url: "https://dash.cloudflare.com/x" }),
      run(6, "check / check", "failure", { head_sha: "b".repeat(40) }),
    ]), reviewChecks)).toEqual([]);
    expect(failedOwnActions(snapshot([run(1, "check / e2e", "failure")]), reviewChecks, new Set([1]))).toEqual([]);
  });

  it("keeps a finished run when a later run of the same check was cancelled", () => {
    // onmax/comark-plugins#87: the pull_request run of a workflow cancelled its passing push run's twin.
    const s = snapshot([run(1, "check / e2e", "success"), run(2, "check / e2e", "cancelled")]);
    expect(snapshotCheckEvidence(s).checkRuns).toMatchObject([{ id: 1, conclusion: "success" }]);
    expect(failedOwnActions(s, reviewChecks)).toEqual([]);
    expect(snapshotCheckEvidence(snapshot([run(1, "e2e", "cancelled"), run(2, "e2e", "cancelled")])).checkRuns).toMatchObject([{ id: 2 }]);
  });

  it("fails a branch without required checks on its own failing Actions, not on inherited ones", () => {
    // comark-plugins#45 had red check and e2e, and its assessed head was about to merge.
    const red = snapshot([run(1, "check / e2e", "failure")]);
    expect(inheritedCheckEvaluation(red, policy([]), new Set(), reviewChecks)).toMatchObject({ state: "failed", inheritedCheckIds: [], bypassedRequiredChecks: [] });
    expect(inheritedCheckEvaluation(red, policy([]), new Set([1]), reviewChecks).state).toBe("passed");
    // Optional failures beside passing required checks still go to assessment.
    expect(inheritedCheckEvaluation(snapshot([run(1, "check / e2e", "failure"), run(2, "ci", "success")]), policy(["ci"]), new Set(), reviewChecks).state).toBe("passed");
  });

  it("passes an inherited required check only when bypassInheritedChecks names it", () => {
    const s = snapshot([run(1, "ci", "failure"), run(2, "lint", "success")]);
    expect(inheritedCheckEvaluation(s, policy(["ci"]), new Set([1]), reviewChecks).state).toBe("failed");
    expect(inheritedCheckEvaluation(s, policy(["ci"]), new Set([1]), reviewChecks, new Set(["ci"]))).toMatchObject({ state: "passed", bypassedRequiredChecks: ["ci"], inheritedCheckIds: [1] });
    expect(inheritedCheckEvaluation(s, policy(["ci"]), new Set(), reviewChecks, new Set(["ci"])).state).toBe("failed");
    // Another own failure blocks the bypass merge.
    const other = snapshot([run(1, "ci", "failure"), run(2, "lint", "failure")]);
    expect(inheritedCheckEvaluation(other, policy(["ci"]), new Set([1]), reviewChecks, new Set(["ci"])).state).toBe("failed");
  });

  it("refuses a bypass merge while another branch rule is unknown or unmet", () => {
    const protection = { required_status_checks: { strict: true, contexts: ["ci"] }, enforce_admins: { enabled: true }, required_signatures: { enabled: false }, lock_branch: { enabled: false } };
    const input = { protection, rules: [], reviewDecision: null, threadsResolved: true, method: "squash" as const, upToDate: true };
    expect(inheritedBypassSafety(input)).toBe(true);
    expect(inheritedBypassSafety({ ...input, protection: undefined })).toBe("merge protection policy unavailable");
    expect(inheritedBypassSafety({ ...input, upToDate: false })).toBe("branch must be up to date");
    expect(inheritedBypassSafety({ ...input, reviewDecision: "REVIEW_REQUIRED" })).toBe("required review not satisfied");
    expect(inheritedBypassSafety({ ...input, protection: { ...protection, required_signatures: { enabled: true } } })).toBe("required signatures cannot be bypassed");
    expect(inheritedBypassSafety({ ...input, protection: { ...protection, required_pull_request_reviews: { required_approving_review_count: 1 } } })).toBe("required review not satisfied");
    expect(inheritedBypassSafety({ ...input, rules: [{ type: "merge_queue" }] })).toBe("cannot bypass branch rule merge_queue");
    expect(inheritedBypassSafety({ ...input, rules: [{ type: "pull_request", parameters: { required_review_thread_resolution: true } }], threadsResolved: false })).toBe("required conversations unresolved");
    expect(inheritedBypassSafety({ ...input, rules: [{ type: "required_linear_history" }], method: "merge" })).toBe("linear history required");
  });

  it("validates bypassInheritedChecks", () => {
    expect(resolveBabysitterMerge({ strategy: "direct", bypassInheritedChecks: { "Vite-Hub/ViteHub": ["CI", "publish preview packages"], "acme/app": [] } })).toEqual({
      mode: "direct", method: "squash", ready: approvedIfOutside, bypassInheritedChecks: new Map([["vite-hub/vitehub", new Set(["ci", "publish preview packages"])]]) });
    expect(resolveBabysitterMerge({ strategy: "direct", bypassInheritedChecks: {} })).toEqual({ mode: "direct", method: "squash", ready: approvedIfOutside });
    expect(() => resolveBabysitterMerge({ strategy: "direct", bypassInheritedChecks: ["ci"] })).toThrow("bypassInheritedChecks");
    expect(() => resolveBabysitterMerge({ strategy: "direct", bypassInheritedChecks: { "acme/app": [""] } })).toThrow("bypassInheritedChecks");
  });
});

describe("Babysitter merge readiness with attributed failures", () => {
  it("merges past inherited failures without an assessment", () => {
    const s = snapshot([run(1, "ci", "failure")]);
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
    expect(directMergeReadiness(s, "passed", { inheritedCheckIds: new Set([1]) })).toEqual({ ready: true, head });
  });

  it("merges an assessed head whose only failing checks are review checks", () => {
    // #2156 took three passes on one head; each assessed it, but the evidence key never matched again.
    const s = snapshot([run(1, "pullfrog", "failure")]);
    const policy = { pendingReviewChecks: reviewChecks, reviewedEvidenceKey: "older-key" };
    expect(directMergeReadiness(s, "passed", { pendingReviewChecks: reviewChecks }).ready).toBe(false);
    expect(directMergeReadiness(s, "passed", policy)).toEqual({ ready: true, head });
    s.checks["check_run:2"] = run(2, "lint", "failure");
    expect(directMergeReadiness(s, "passed", policy)).toEqual({ ready: false, reason: "current-head failures need assessment" });
  });
});

describe("Babysitter missing required checks", () => {
  const evaluation = { state: "pending" as const, checks: [{ context: "ci", state: "pending" as const }], missing: ["ci"] };
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("names a required check that never reported once every check finished ten minutes ago", () => {
    // vitehub #3161 and #3162: the `ci` job was missing from their successful CI runs.
    const done = snapshot([run(1, "lint", "success", { completed_at: "2026-11-01T11:45:00Z" })]);
    expect(missingRequiredChecks(done, evaluation, now)).toEqual(["ci"]);
    expect(missingRequiredChecks(snapshot([run(1, "lint", "success", { completed_at: "2026-11-01T11:55:00Z" })]), evaluation, now)).toEqual([]);
    expect(missingRequiredChecks(snapshot([run(1, "lint", null, { completed_at: "2026-11-01T11:00:00Z" })]), evaluation, now)).toEqual([]);
    expect(missingRequiredChecks(done, { ...evaluation, missing: [] }, now)).toEqual([]);
  });
});
