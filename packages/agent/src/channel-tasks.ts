import { agentDiagnostics } from "./agent-diagnostics.ts"

import type { AgentRunInput, AgentRunMetadata } from "./types.ts"

export interface EnqueueChannelTaskOptions {
  /** Earliest time the task may start. Defaults to now. Set it or `delayMs`, not both. */
  notBefore?: Date | number
  /** Milliseconds from now before the task may start. */
  delayMs?: number
  /**
   * A later enqueue of the same task with the same key replaces a queued task that has not started.
   * `cancelChannelTask()` drops it. The new start time does not extend from the old one.
   */
  key?: string
  /** The trigger that declares the task. Needed only when more than one trigger of the Channel declares it. */
  trigger?: string
  /** Run metadata for the Invocation, such as `annotations` that the task's `failed` callback reads. */
  run?: Omit<AgentRunMetadata, "runId">
}

export interface CancelChannelTaskOptions {
  /** The `key` that the task was enqueued with. */
  key: string
  /** The trigger that declares the task. Needed only when more than one trigger of the Channel declares it. */
  trigger?: string
}

export interface ChannelTaskReceipt {
  /** The queue delivery ID. The Console lists the task under it. */
  deliveryId: string
  /** The Invocation run ID that the task gets when it starts. */
  runId: string
  /** Earliest start time, in milliseconds since the epoch. */
  notBefore: number
}

/** Internal: a running webhook queue that can take Channel tasks. */
export interface ChannelTaskQueue {
  agentName: string
  cancel: (channel: string, task: string, options: CancelChannelTaskOptions) => Promise<number>
  enqueue: (channel: string, task: string, input: AgentRunInput, options: EnqueueChannelTaskOptions & { notBefore: number }) => Promise<ChannelTaskReceipt>
}

interface ChannelTaskRegistry {
  queues: Map<string, Set<ChannelTaskQueue>>
  starting: Set<Promise<unknown>>
}

const registryKey = Symbol.for("vitehub.agent.channelTaskQueues")

// The route chunk and the public entry can load as separate module instances in dev, so they share one registry.
function channelTaskRegistry(): ChannelTaskRegistry {
  const holder = globalThis as typeof globalThis & { [registryKey]?: ChannelTaskRegistry }
  return holder[registryKey] ??= { queues: new Map(), starting: new Set() }
}

/** Internal: a webhook queue that is starting. Channel task calls wait for it, so a call right after startup finds its Channel. */
export function startingChannelTaskQueue(starting: Promise<unknown>): void {
  const registry = channelTaskRegistry()
  const settled = starting.catch(() => undefined).finally(() => registry.starting.delete(settled))
  registry.starting.add(settled)
}

/** Internal: the webhook queue of an Agent registers the Channels it serves while it runs. Returns the unregister function. */
export function registerChannelTaskQueue(channels: readonly string[], queue: ChannelTaskQueue): () => void {
  const { queues } = channelTaskRegistry()
  for (const channel of channels) {
    const registered = queues.get(channel) ?? new Set()
    registered.add(queue)
    queues.set(channel, registered)
  }
  return () => {
    for (const channel of channels) {
      const registered = queues.get(channel)
      registered?.delete(queue)
      if (registered?.size === 0) queues.delete(channel)
    }
  }
}

async function channelTaskQueue(channel: string): Promise<ChannelTaskQueue> {
  const registry = channelTaskRegistry()
  await Promise.all(registry.starting)
  const registered = [...registry.queues.get(channel) ?? []]
  if (registered.length === 1) return registered[0]!
  if (registered.length > 1) {
    throw agentDiagnostics.AGENT_R1025({ message: `[vitehub] Channel "${channel}" is served by more than one Agent (${registered.map(queue => queue.agentName).join(", ")}). Give the Channel one Agent.` })
  }
  throw agentDiagnostics.AGENT_R1025({ message: `[vitehub] Channel "${channel}" has no running webhook queue. Channel tasks need a declared Channel webhook and durable SQLite or libSQL Agent State.` })
}

function validTaskName(channel: unknown, task: unknown): channel is string {
  return typeof channel === "string" && channel.trim() !== "" && typeof task === "string" && task.trim() !== ""
}

function startTime(options: EnqueueChannelTaskOptions): number {
  const { delayMs, notBefore } = options
  if (notBefore !== undefined && delayMs !== undefined) {
    throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] enqueueChannelTask() takes notBefore or delayMs, not both." })
  }
  if (delayMs !== undefined) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] enqueueChannelTask() delayMs must be a non-negative integer." })
    return Date.now() + delayMs
  }
  if (notBefore === undefined) return Date.now()
  const at = notBefore instanceof Date ? notBefore.getTime() : notBefore
  if (!Number.isFinite(at)) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] enqueueChannelTask() notBefore must be a valid Date or a finite timestamp." })
  return at
}

function validKey(key: unknown): boolean {
  return typeof key === "string" && key.trim() !== ""
}

/**
 * Queue a task that a Channel trigger declares, to run at `notBefore` or after `delayMs`. The task runs through the
 * Channel's webhook queue like a queued webhook delivery: its `prepare` and `failed`, retries, concurrency, restart
 * replay and Console view all apply. Tasks with the same name run one at a time.
 *
 * `input` is the Agent run input that the trigger's `invoke` would return for the task, such as `{ data, prompt }`.
 *
 * @example
 * const [error] = await enqueueChannelTask("airtable", "close-duplicate", { data: { closeId, survivorId } }, {
 *   notBefore: nextWorkingDay(),
 *   key: `duplicate-pair:${closeId}:${survivorId}`,
 * })
 */
export async function enqueueChannelTask(
  channel: string,
  task: string,
  input: AgentRunInput,
  options: EnqueueChannelTaskOptions = {},
): Promise<[error: Error, receipt: null] | [error: null, receipt: ChannelTaskReceipt]> {
  try {
    if (!validTaskName(channel, task)) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] enqueueChannelTask() needs a non-empty Channel name and task name." })
    if (options.key !== undefined && !validKey(options.key)) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] enqueueChannelTask() key must be a non-empty string." })
    const notBefore = startTime(options)
    return [null, await (await channelTaskQueue(channel)).enqueue(channel, task, input, { ...options, notBefore })]
  }
  catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), null]
  }
}

/** Drop the queued tasks that `enqueueChannelTask()` queued with this `key`. A task that has started keeps running. */
export async function cancelChannelTask(
  channel: string,
  task: string,
  options: CancelChannelTaskOptions,
): Promise<[error: Error, result: null] | [error: null, result: { cancelled: number }]> {
  try {
    if (!validTaskName(channel, task)) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] cancelChannelTask() needs a non-empty Channel name and task name." })
    if (!validKey(options?.key)) throw agentDiagnostics.AGENT_R1025({ message: "[vitehub] cancelChannelTask() needs the non-empty key that the task was enqueued with." })
    return [null, { cancelled: await (await channelTaskQueue(channel)).cancel(channel, task, options) }]
  }
  catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), null]
  }
}

/** The queue debounce key of a Channel task key. The task name keeps it apart from trigger debounce keys. */
export function channelTaskDebounceKey(task: string, key: string): string {
  return `task:${task}:${key}`
}
