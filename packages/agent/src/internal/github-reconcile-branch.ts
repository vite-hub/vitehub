import type { AgentChannelState, AgentChannelStateBinding } from "../types.ts"
import { createAgentChannelState } from "./channel-state.ts"
import { createAgentInvocationCancellationError } from "./invocation-cancellation.ts"

/** The last branch events of one pull request, saved in Channel State. Times are milliseconds since the epoch. */
interface PullRequestBranchRecord {
  closed?: { actor: string, at: number }
  lastClose?: { actor: string, at: number }
  deliveries?: string[]
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
export async function recordPullRequestBranchEvent(channelState: AgentChannelState | undefined, pullRequest: string, event: PullRequestBranchEvent, deliveryId?: string): Promise<boolean> {
  if (!channelState) return false
  // Lifecycle invalidation must be durable before aborting work releases queue slots.
  return createAgentChannelState(channelState).transaction<PullRequestBranchRecord, boolean>(stateKey(pullRequest), (record) => {
    if (deliveryId && record.value?.deliveries?.includes(deliveryId)) return false
    const at = Date.now()
    const { closed: _closed, ...open } = record.value ?? {}
    const deliveries = [...(record.value?.deliveries ?? []), ...(deliveryId ? [deliveryId] : [])]
    if (event.kind === "push") record.set({ ...record.value, deliveries, push: { actor: event.actor, at, ...(event.sha ? { sha: event.sha } : {}) } })
    else if (event.kind === "closed") record.set({ ...open, deliveries, closed: { actor: event.actor, at }, lastClose: { actor: event.actor, at } })
    else record.set({ ...open, deliveries })
    return true
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
  if (!channelState) return {}
  const value = await channelState.state.get<PullRequestBranchRecord>(`${channelState.keyPrefix}${stateKey(pullRequest)}`)
  if (!value) return {}
  return {
    ...(value.closed || (since !== undefined && value.lastClose && value.lastClose.at >= since) ? { closed: value.closed || value.lastClose } : {}),
    ...(value.push && since !== undefined && value.push.at > since ? { push: value.push } : {}),
  }
}

/** The prompt paragraph for a queued reconcile run whose branch moved before it started. */
export function pullRequestBranchMovedNotice(push: NonNullable<PullRequestBranchRecord["push"]>): string {
  const commit = push.sha ? `commit ${push.sha}` : "new commits"
  return `While this request waited, ${push.actor} pushed ${commit} to the pull request branch. The checkout includes that push. Check whether the request still applies before you edit or push, and do not repeat work that the push already did.`
}

// State identity and prefix retain the Agent and Channel that own each execution.
const owners = new WeakMap<AgentChannelStateBinding["state"], Map<string, Map<AbortSignal, { controller: AbortController, invocationId: () => Promise<string> }>>>()
const releases = new WeakMap<AbortSignal, () => void>()

export function releaseReconcileRun(signal: AbortSignal | undefined): void {
  if (signal) releases.get(signal)?.()
}

export function trackReconcileRun(binding: AgentChannelStateBinding, pullRequest: string, invocationId: () => Promise<string>): AbortSignal {
  const groups = owners.get(binding.state) ?? new Map()
  owners.set(binding.state, groups)
  const key = `${binding.keyPrefix}${pullRequest}`
  const runs = groups.get(key) ?? new Map()
  groups.set(key, runs)
  const controller = new AbortController()
  runs.set(controller.signal, { controller, invocationId })
  releases.set(controller.signal, () => {
    runs.delete(controller.signal)
    releases.delete(controller.signal)
    if (!runs.size) groups.delete(key)
  })
  return controller.signal
}

export async function cancelReconcileRuns(binding: AgentChannelStateBinding, pullRequest: string): Promise<void> {
  const runs = owners.get(binding.state)?.get(`${binding.keyPrefix}${pullRequest}`)
  if (!runs) return
  for (const { controller, invocationId } of Array.from(runs.values())) {
    controller.abort(createAgentInvocationCancellationError(await invocationId()))
  }
}
