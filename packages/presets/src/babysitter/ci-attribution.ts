import { stripVTControlCharacters } from "node:util";
import { evaluateGitHubRequiredChecks, type GitHubRequiredCheckPolicy } from "../github/index.ts";
import { isRuntimeRecord } from "../internal/runtime-type.ts";
import { actionLocation, failed, newestCheckRun } from "./inbox/ci-evidence.ts";
import type { Snapshot } from "./inbox/store.ts";
import type { BabysitterMergeMethod } from "./merge.ts";
import { snapshotCheckEvidence } from "./merge.ts";

/** The output of the step that failed an Actions job, without timestamps, colours, durations and ids. */
export interface FailedActionOutput {
  step: string;
  lines: Set<string>;
}

const strip = (line: string) => stripVTControlCharacters(line.replace(/^\S+Z /, ""));

/** Undefined when no step exited with an error code. */
export function parseFailedActionOutput(log: string): FailedActionOutput | undefined {
  const lines = log.split("\n").map(line => strip(line).trimEnd());
  const end = lines.findIndex(line => line.startsWith("##[error]Process completed with exit code"));
  const start = end < 0 ? -1 : lines.findLastIndex((line, index) => index < end && line.startsWith("##[group]Run "));
  const commandEnd = start < 0 ? -1 : lines.findIndex((line, index) => index > start && index < end && line.startsWith("##[endgroup]"));
  if (commandEnd < 0) return undefined;
  return {
    step: lines[start]!,
    lines: new Set(lines.slice(commandEnd + 1, end)
      .filter(line => line && !line.startsWith("##[group]") && !line.startsWith("##[endgroup]"))
      .map(line => line
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
        .replace(/\b\d+(\.\d+)?\s?(ms|s|m)\b/g, "<time>")
        .replace(/\b\d\d:\d\d:\d\d\b/g, "<clock>"))),
  };
}

/**
 * Lines that name what failed: test runner FAIL and × lines, error totals and Actions error annotations.
 * Build-size and pass-count lines differ between any two runs, so they stay out.
 */
const failureSignaturePatterns = [/^\s*FAIL\s+\S/, /^\s*[×✗]\s+\S/, /^##\[error\]/, /^\s*(?:Type )?Errors\s+\d/, /Unhandled (?:Errors?|Rejection|Source Error)/];

function failureSignatures(output: FailedActionOutput): Set<string> {
  return new Set([...output.lines].filter(line => failureSignaturePatterns.some(pattern => pattern.test(line))).map(line => line.trim()));
}

/**
 * Whether a PR job fails only the way its base job does. When the output names its failures, each one
 * must also fail on the base: a PR job may run a narrower command, such as tests of changed packages
 * only, and print other build lines. Output that names no failure must match line for line, in the
 * same step. On vite-hub/drop#42 and #24 main failed knip, and the PRs had their own unused file and
 * type errors in the same job.
 */
export function sameActionFailure(own: FailedActionOutput | undefined, base: FailedActionOutput | undefined): boolean {
  if (!own || !base || !own.lines.size || !base.lines.size) return false;
  const ownFailures = failureSignatures(own);
  if (ownFailures.size) {
    const baseFailures = failureSignatures(base);
    return [...ownFailures].every(line => baseFailures.has(line));
  }
  return own.step === base.step && [...own.lines].every(line => base.lines.has(line));
}

/**
 * Log lines that only a runner or the network causes: a lost runner, or a registry, Git or image fetch
 * that failed. Errors a PR can cause, such as test timeouts or a refused local port, are left out.
 */
const infrastructureFailurePatterns = [
  /The runner has received a shutdown signal/,
  /lost communication with the server/i,
  /The hosted runner encountered an error/i,
  /An error occurred while provisioning resources/i,
  /ERR_PNPM_META_FETCH_FAIL/,
  /ERR_PNPM_FETCH_(?:429|5\d\d)\b/,
  /\bnpm (?:ERR!|error) code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/,
  /getaddrinfo EAI_AGAIN/,
  /fatal: unable to access 'https:\/\/github\.com\/[^']*': (?:The requested URL returned error: 5\d\d|Could not resolve host|Failed to connect)/,
  /\bRPC failed; HTTP 5\d\d\b/,
  /toomanyrequests: You have reached your pull rate limit/,
  /net\/http: TLS handshake timeout/,
  // @actions/tool-cache, which setup actions use to download a tool, after its own retries.
  /^##\[error\]Error: Unexpected HTTP response: 5\d\d$/,
];

/** What a failed Actions job log shows. */
export interface JobFailureFacts {
  /** The first line that shows a runner or network error. */
  infrastructure?: string;
  /** The failed step only reports other jobs' results, as a required gate job does (`package-tests: failure`). */
  gate: boolean;
}

export function jobFailureFacts(log: string): JobFailureFacts {
  const output = parseFailedActionOutput(log);
  let infrastructure: string | undefined;
  for (const raw of log.split("\n")) {
    const line = strip(raw).trim();
    if (infrastructureFailurePatterns.some(pattern => pattern.test(line))) {
      infrastructure = line.replace(/^##\[error\]/, "").slice(0, 200);
      break;
    }
  }
  return {
    ...infrastructure ? { infrastructure } : {},
    gate: Boolean(output?.lines.size) && [...output!.lines].every(line => /^[\w.-]+: (?:failure|cancelled|timed_out|skipped)$/.test(line)),
  };
}

/**
 * Why one failing check fails: `inherited` when its job fails the same way on the base tip,
 * `infrastructure` for a runner or network error, and `pr` otherwise.
 */
export type FailureCause =
  | { name: string; runId?: number; cause: "inherited" }
  | { name: string; runId?: number; cause: "infrastructure"; line: string }
  | { name: string; runId?: number; cause: "pr"; gate?: boolean };

export interface UnrelatedFailureWait {
  reason: string;
  checks: string[];
  infrastructure: boolean;
  retryAt?: number;
}

/**
 * The wait for a PR whose failing checks it did not cause, or undefined when a pass has work: one `pr`
 * failure, or no failure. On 2026-11-05 vitehub#3024 and comark-ui#351 spent their repair pushes on
 * failures their changes did not cause.
 */
export function unrelatedFailureWait(causes: readonly FailureCause[], base: string, now = Date.now()): UnrelatedFailureWait | undefined {
  // A gate job fails because of the other failed jobs in its run, so their causes decide.
  const covered = (gate: FailureCause) => gate.cause === "pr" && gate.gate && causes.some(other => other !== gate && !(other.cause === "pr" && other.gate) && other.runId !== undefined && other.runId === gate.runId);
  const failures = causes.filter(cause => !covered(cause));
  if (!failures.length || failures.some(failure => failure.cause === "pr")) return undefined;
  const inherited = failures.filter(failure => failure.cause === "inherited").map(failure => failure.name);
  const infrastructure = failures.flatMap(failure => failure.cause === "infrastructure" ? [failure] : []);
  const parts: string[] = [];
  if (inherited.length) parts.push(`${inherited.join(", ")} fail${inherited.length === 1 ? "s" : ""} the same way on ${base}; the host retests this PR when ${base} passes`);
  if (infrastructure.length) parts.push(`${infrastructure.map(failure => `${failure.name} (${failure.line})`).join(", ")} hit a runner or network error; the host updates the branch for a fresh run`);
  return {
    reason: `No repair pass: this PR did not cause its failing checks. ${parts.join(". ")}.`,
    checks: failures.map(failure => failure.name),
    infrastructure: infrastructure.length > 0,
    // The base has no webhook into this PR, so look again later. A branch the host could not update for
    // a runner error is tried again once the base moves.
    retryAt: now + (inherited.length ? 15 * 60_000 : 60 * 60_000),
  };
}

/** The newest current-head GitHub Actions run of each check outside `reviewChecks`. */
export function currentActionRuns(snapshot: Snapshot, reviewChecks: ReadonlySet<string>) {
  const head = snapshot.pr?.head?.sha;
  const newest = new Map<string, Snapshot["checks"][string]>();
  if (!head) return [];
  for (const check of Object.values(snapshot.checks)) {
    if (check.deleted || check.head_sha !== head || !actionLocation(snapshot.repository, check)?.runId) continue;
    const name = String(check.name);
    if (reviewChecks.has(name.toLowerCase())) continue;
    newest.set(name, newestCheckRun(newest.get(name), check));
  }
  return [...newest.values()];
}

/**
 * Names of the failing current-head GitHub Actions checks outside `reviewChecks` and `inheritedCheckIds`.
 * Third-party checks such as Vercel or Workers Builds do not count.
 */
export function failedOwnActions(snapshot: Snapshot, reviewChecks: ReadonlySet<string>, inheritedCheckIds: ReadonlySet<number> = new Set()): string[] {
  return currentActionRuns(snapshot, reviewChecks)
    .filter(check => failed(check) && !inheritedCheckIds.has(Number(check.id)))
    .map(check => String(check.name));
}

export type InheritedCheckEvaluation = ReturnType<typeof evaluateGitHubRequiredChecks> & {
  /** Current-head checks that fail the same way on the base tip. */
  inheritedCheckIds: number[];
  /** Required checks that the merge may bypass because they only repeat the base's failure. */
  bypassedRequiredChecks: string[];
};

/**
 * The required-check evaluation with the PR's own failing Actions counted. Where a branch requires no
 * checks, GitHub reported `passed` beside failing CI, so an assessed head could merge red
 * (comark-plugins#45). Failures inherited from the base do not count against the PR, and a required
 * check named in `bypassChecks` that only repeats the base's failure passes.
 */
export function inheritedCheckEvaluation(snapshot: Snapshot, policy: GitHubRequiredCheckPolicy, inheritedCheckIds: ReadonlySet<number>, reviewChecks: ReadonlySet<string>, bypassChecks: ReadonlySet<string> = new Set()): InheritedCheckEvaluation {
  const evidence = snapshotCheckEvidence(snapshot);
  const bypassed = evidence.checkRuns.filter(check => inheritedCheckIds.has(check.id) && bypassChecks.has(check.name.toLowerCase())
    && policy.required.some(required => required.context === check.name && (required.appId === null || required.appId === check.app?.id)));
  const bypassIds = new Set(bypassed.map(check => check.id));
  const evaluation = evaluateGitHubRequiredChecks(policy, { ...evidence, checkRuns: evidence.checkRuns.map(check => bypassIds.has(check.id) ? { ...check, conclusion: "neutral" } : check) });
  const failing = failedOwnActions(snapshot, reviewChecks, inheritedCheckIds);
  return {
    ...evaluation,
    state: evaluation.state === "passed" && (!evaluation.checks.length || bypassed.length) && failing.length ? "failed" : evaluation.state,
    inheritedCheckIds: [...inheritedCheckIds],
    bypassedRequiredChecks: [...new Set(bypassed.map(check => check.name))],
  };
}

export interface InheritedBypassInput {
  /** `GET /repos/{repository}/branches/{branch}/protection`. */
  protection: unknown;
  /** `GET /repos/{repository}/rules/branches/{branch}`. */
  rules: unknown;
  reviewDecision: unknown;
  threadsResolved: boolean;
  method: BabysitterMergeMethod;
  /** The head contains the base tip. */
  upToDate: boolean;
}

/**
 * A bypass merge skips every branch rule, not only the inherited checks. It is safe only when every
 * other rule is known and satisfied. Returns `true`, or why the bypass is refused.
 */
export function inheritedBypassSafety({ protection, rules, reviewDecision, threadsResolved, method, upToDate }: InheritedBypassInput): true | string {
  if (!isRuntimeRecord(protection) || !isRuntimeRecord(protection.required_status_checks) || !Array.isArray(rules)) return "merge protection policy unavailable";
  if (![null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(reviewDecision as string | null)) return "review decision unavailable";
  if (reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED") return "required review not satisfied";
  const enabled = (key: string) => isRuntimeRecord(protection[key]) ? protection[key].enabled : undefined;
  if (enabled("lock_branch") !== false) return "branch lock policy unavailable or locked";
  if (enabled("required_signatures") !== false) return "required signatures cannot be bypassed";
  if (protection.restrictions != null) return "branch update restrictions cannot be bypassed";
  const known = new Set(["url", "required_status_checks", "enforce_admins", "required_signatures", "required_linear_history", "allow_force_pushes", "allow_deletions",
    "block_creations", "required_conversation_resolution", "lock_branch", "allow_fork_syncing", "required_pull_request_reviews", "restrictions"]);
  if (Object.keys(protection).some(key => !known.has(key))) return "unsupported branch protection";
  let strict = protection.required_status_checks.strict === true;
  let linear = enabled("required_linear_history") === true;
  let resolved = enabled("required_conversation_resolution") === true;
  const reviews = [protection.required_pull_request_reviews].filter(isRuntimeRecord);
  for (const rule of rules) {
    if (!isRuntimeRecord(rule)) return "active branch rule unavailable";
    const parameters = isRuntimeRecord(rule.parameters) ? rule.parameters : undefined;
    if (rule.type === "required_status_checks") strict ||= parameters?.strict_required_status_checks_policy === true;
    else if (rule.type === "required_linear_history") linear = true;
    else if (rule.type === "pull_request") {
      if (!parameters) return "pull request rule unavailable";
      reviews.push(parameters);
      resolved ||= parameters.required_review_thread_resolution === true;
    }
    else if (!["non_fast_forward", "deletion", "creation"].includes(String(rule.type))) return `cannot bypass branch rule ${String(rule.type)}`;
  }
  if (reviews.some(review => review.allowed_merge_methods !== undefined && (!Array.isArray(review.allowed_merge_methods) || !review.allowed_merge_methods.includes(method)))) return "merge method disallowed by branch rule";
  if (reviews.some(review => Number(review.required_approving_review_count) > 0 || review.require_code_owner_review === true || review.require_code_owner_reviews === true || review.require_last_push_approval === true) && reviewDecision !== "APPROVED") return "required review not satisfied";
  if (resolved && !threadsResolved) return "required conversations unresolved";
  if (linear && method === "merge") return "linear history required";
  if (strict && !upToDate) return "branch must be up to date";
  return true;
}
