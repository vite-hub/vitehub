import type { AgentChannelState, AgentChannelStateBinding } from "../types.ts"
import { createAgentInvocationCancellationError } from "./invocation-cancellation.ts"

/** The last branch events of one pull request, saved in Channel State. Times are milliseconds since the epoch. */
interface PullRequestBranchRecord {
  closed?: { actor: string, at: number }
  push?: { actor: string, at: number, sha?: string }
}

export type PullRequestBranchEvent =
  | { kind: "closed", actor: string }
  | { kind: "push", actor: string, sha?: string }
  | { kind: "reopened" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function stateKey(pullRequest: string): string {
  return `reconcile-branch:${pullRequest}`
}

/**
 * The branch event in a `pull_request` webhook payload. A push by a bot account, such as the Agent's own GitHub App,
 * is not an event, the same as for `synchronize` reconcile runs.
 */
export function pullRequestBranchEvent(event: string | undefined, payload: unknown): PullRequestBranchEvent | undefined {
  if (event !== "pull_request" || !isRecord(payload) || !isRecord(payload.pull_request)) return
  const sender = isRecord(payload.sender) ? payload.sender : undefined
  const actor = text(sender?.login)
  if (payload.action === "reopened") return { kind: "reopened" }
  if (!actor) return
  if (payload.action === "closed") return { kind: "closed", actor }
  if (payload.action !== "synchronize" || text(sender?.type)?.toLowerCase() === "bot") return
  const head = isRecord(payload.pull_request.head) ? payload.pull_request.head : undefined
  const sha = text(head?.sha) || text(payload.after)
  return { kind: "push", actor, ...(sha ? { sha } : {}) }
}

/** Saves `event` for `pullRequest` (`owner/repo#number`), so reconcile runs that start later can see it. */
export async function recordPullRequestBranchEvent(channelState: AgentChannelState | undefined, pullRequest: string, event: PullRequestBranchEvent): Promise<void> {
  if (!channelState) return
  const at = Date.now()
  await channelState.transaction<PullRequestBranchRecord, undefined>(stateKey(pullRequest), (record) => {
    const { closed, ...open } = record.value ?? {}
    if (event.kind === "push") record.set({ ...record.value, push: { actor: event.actor, at, ...(event.sha ? { sha: event.sha } : {}) } })
    else if (event.kind === "closed") record.set({ ...open, closed: { actor: event.actor, at } })
    // A reopened pull request takes new runs again.
    else if (closed) record.set(open)
    return undefined
  })
}

/**
 * The branch events of `pullRequest` after `since`, the time the queue accepted a reconcile run. A `synchronize` run is
 * accepted after its own push is recorded, so its push does not count.
 */
export async function pullRequestBranchEventsSince(
  channelState: AgentChannelStateBinding | undefined,
  pullRequest: string,
  since: number | undefined,
): Promise<PullRequestBranchRecord> {
  if (!channelState || since === undefined) return {}
  const value = await channelState.state.get<PullRequestBranchRecord>(`${channelState.keyPrefix}${stateKey(pullRequest)}`)
  if (!value) return {}
  return {
    ...(value.closed && value.closed.at > since ? { closed: value.closed } : {}),
    ...(value.push && value.push.at > since ? { push: value.push } : {}),
  }
}

/** The prompt paragraph for a queued reconcile run whose branch moved before it started. */
export function pullRequestBranchMovedNotice(push: NonNullable<PullRequestBranchRecord["push"]>): string {
  const commit = push.sha ? `commit ${push.sha}` : "new commits"
  return `While this request waited, ${push.actor} pushed ${commit} to the pull request branch. The checkout includes that push. Check whether the request still applies before you edit or push, and do not repeat work that the push already did.`
}

// Reconcile runs that started in this process, by pull request, then by run ID.
const runningReconciles = new Map<string, Map<string, AbortController>>()

/**
 * Tracks a reconcile run that starts in this process and returns the abort signal for its input. Keeps the newest
 * `limit` runs per pull request: the queue runs at most `limit` at once, so an older entry belongs to a finished run.
 */
export function trackReconcileRun(pullRequest: string, runId: string, limit: number): AbortSignal {
  const runs = runningReconciles.get(pullRequest) ?? new Map<string, AbortController>()
  runs.delete(runId)
  const controller = new AbortController()
  runs.set(runId, controller)
  for (const oldest of runs.keys()) {
    if (runs.size <= limit) break
    runs.delete(oldest)
  }
  runningReconciles.set(pullRequest, runs)
  return controller.signal
}

/**
 * Cancels the reconcile runs of `pullRequest` that run in this process. The abort reason is the Invocation
 * cancellation error, so the webhook queue settles each run as cancelled and does not retry it.
 */
export async function cancelReconcileRuns(pullRequest: string, invocationId: (runId: string) => Promise<string>): Promise<void> {
  const runs = runningReconciles.get(pullRequest)
  if (!runs) return
  runningReconciles.delete(pullRequest)
  for (const [runId, controller] of runs) controller.abort(createAgentInvocationCancellationError(await invocationId(runId)))
}
