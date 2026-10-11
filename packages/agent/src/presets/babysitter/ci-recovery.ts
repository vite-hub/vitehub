import * as v from "valibot";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type { GitHubHost } from "../../server/github.ts";
import type { Claim, PullRequestInbox, Snapshot } from "../../server/github-inbox.ts";
import { actionLocation, failed } from "../../server/github-inbox/ci-evidence.ts";

export function hasFailedActions(snapshot: Snapshot): boolean {
  const head = snapshot.pr?.head?.sha;
  return Boolean(head && Object.values(snapshot.checks).some(check => failed(check) && check.head_sha === head && actionLocation(snapshot.repository, check)?.runId));
}

export type CiRecoveryResult =
  | { state: "rerun"; runs: { runId: number; checkName?: string }[] }
  | { state: "waiting"; runs: { runId: number; checkName?: string; reason: string }[]; reason: string }
  | { state: "blocked"; reason: string; permission?: boolean };
type RecoveryRun = { runId: number; checkName?: string; completedAt: number };
const workflowRunSchema = v.object({
  head_sha: v.string(), run_attempt: v.number(), status: v.string(), conclusion: v.nullish(v.string()),
  run_started_at: v.string(),
});
const permissionFailure = (reason: string): boolean => /\b403\b|forbidden|resource not accessible|permission|not permitted/i.test(reason);

/** Reruns failed Actions once per PR head and records provider failures durably. */
export async function rerunFailedActions(
  inbox: Pick<PullRequestInbox, "meta" | "setMeta">,
  claim: Claim,
  command: GitHubHost["command"],
  now = Date.now(),
): Promise<CiRecoveryResult | undefined> {
  const { repository } = claim.snapshot;
  const headSha = claim.snapshot.pr?.head?.sha;
  if (!headSha) return undefined;
  const runs = new Map<number, RecoveryRun>();
  for (const check of Object.values(claim.snapshot.checks)) {
    if (!failed(check) || check.head_sha !== headSha) continue;
    const location = actionLocation(repository, check);
    if (!location || !Number.isSafeInteger(location.runId)) continue;
    const completedAt = Date.parse(check.completed_at ?? "") || 0;
    const existing = runs.get(location.runId);
    if (!existing || completedAt > existing.completedAt) runs.set(location.runId, { runId: location.runId, checkName: check.name, completedAt });
  }
  if (!runs.size) return undefined;
  const rerun: RecoveryRun[] = [];
  const blocked: { runId: number; checkName?: string; reason: string }[] = [];
  const waiting: { runId: number; checkName?: string; reason: string }[] = [];
  let attempted = 0;
  for (const run of runs.values()) {
    const metadataKey = `ci-rerun:v1:${repository}:${headSha}:${run.runId}`;
    const previous = await inbox.meta(metadataKey);
    const succeeded = isRuntimeRecord(previous) && (previous.status === "succeeded" || previous.status === "pending");
    let fenced = succeeded;
    let posted = false;
    if (isRuntimeRecord(previous) && (previous.status === "blocked" || previous.status === "failed") && Number(previous.retryAt ?? 0) > now) {
      blocked.push({ ...run, reason: String(previous.reason ?? "Automatic GitHub Actions rerun is waiting for a retry window.") });
      continue;
    }
    if (!succeeded && attempted >= 3) {
      waiting.push({ ...run, reason: "Waiting for the next recovery batch." });
      continue;
    }
    try {
      // Check-run payloads do not contain run_attempt. Read the actual workflow
      // before requesting a rerun or deciding that a prior rerun has finished.
      const response = await command(["api", `repos/${repository}/actions/runs/${run.runId}`], { repository, timeout: 60_000 });
      const current = v.parse(workflowRunSchema, JSON.parse(response.stdout));
      if (current.head_sha !== headSha || current.status !== "completed" || !failed(current)) {
        waiting.push({ ...run, reason: "Waiting for current failed check evidence from the workflow run." });
        continue;
      }
      if (succeeded) {
        const newerAttempt = hasRuntimeType(previous.runAttempt, "number")
          ? current.run_attempt > previous.runAttempt
          : Date.parse(current.run_started_at) > Number(previous.attemptedAt);
        // A missed webhook can leave the original failed job in the snapshot.
        // The idle recovery wake forces hydration; only fresh failed jobs may
        // reach repair, even when the workflow has already finished its rerun.
        if (!newerAttempt && previous.status === "pending" && now - Number(previous.attemptedAt) >= 120_000) {
          // An interrupted request with no newer attempt is ambiguous. Keep the
          // fence and release repair instead of issuing a duplicate POST.
          continue;
        }
        if (!newerAttempt || run.completedAt < Date.parse(current.run_started_at)) {
          waiting.push({ ...run, reason: "A rerun was already attempted for this PR head; waiting for the next check result." });
        }
        continue;
      }
      attempted++;
      await inbox.setMeta(metadataKey, { status: "pending", runId: run.runId, headSha, runAttempt: current.run_attempt, attemptedAt: now });
      fenced = true;
      const endpoint = current.conclusion === "cancelled" ? "rerun" : "rerun-failed-jobs";
      await command(["api", "-X", "POST", `repos/${repository}/actions/runs/${run.runId}/${endpoint}`], { repository, timeout: 60_000 });
      posted = true;
      await inbox.setMeta(metadataKey, { status: "succeeded", runId: run.runId, headSha, runAttempt: current.run_attempt, attemptedAt: now });
      rerun.push(run);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const permission = permissionFailure(reason);
      // A failed reconciliation read must not overwrite a successful POST and
      // allow another rerun after the retry window.
      // Server errors leave delivery ambiguous; retain the pre-request fence.
      const rejected = /\bHTTP[ :]+4\d\d\b/i.test(reason);
      if (!fenced || (!succeeded && !posted && (permission || rejected))) {
        const retryAt = now + (permission ? 15 * 60_000 : 2 * 60_000);
        await inbox.setMeta(metadataKey, { status: permission ? "blocked" : "failed", runId: run.runId, headSha, attemptedAt: now, retryAt, reason });
      }
      blocked.push({ ...run, reason });
    }
  }
  if (rerun.length) return { state: "rerun", runs: rerun };
  if (waiting.length) return { state: "waiting", runs: waiting, reason: waiting.map(run => `Actions run ${run.runId}: ${run.reason}`).join("; ") };
  if (blocked.length) return { state: "blocked", permission: blocked.some(run => permissionFailure(run.reason)), reason: blocked.map(run => `Actions run ${run.runId}: ${run.reason}`).join("; ") };
  return undefined;
}
