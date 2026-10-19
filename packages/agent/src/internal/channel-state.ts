import type { Lock, StateAdapter } from "chat"

import type {
  AgentChannelState,
  AgentChannelStateBinding,
  AgentChannelStateTransaction,
  AgentChannelStateTransactionOptions,
  MaybePromise,
} from "../types.ts"
import type { AgentStateCacheMutation } from "./state-lock.ts"
import type { AgentWebhookQueue, AgentWebhookQueueDelivery, AgentWebhookQueueRegistration } from "./webhook-queue.ts"
import { hasAgentWebhookQueue } from "./webhook-queue.ts"
import { isResponse } from "./response.ts"
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "./runtime-value.ts"

export const channelStateLockTtlMs: number = 60_000
export const channelStateLockWaitMs: number = 10_000

/** The writes that a State commits with one queue admission, or alone. */
export interface AgentChannelStateWrites {
  /** Queued unless a delivery with the same ID is already queued. */
  delivery?: AgentWebhookQueueDelivery
  /** Every lock must still be held, or nothing is written or queued. */
  locks: readonly Lock[]
  /** Applied even when `delivery` was already queued. */
  mutations: readonly AgentStateCacheMutation[]
}

/** A State that commits Channel State writes and a queue admission in one transaction, such as SQLite or libSQL. */
export interface AgentChannelStateCommitAdapter extends StateAdapter {
  /** Returns whether `delivery` was newly queued, or `true` without a delivery. Throws when a lock is no longer held. */
  commitWebhookState(writes: AgentChannelStateWrites): Promise<boolean>
}

/** The locks and staged writes of one trigger call. Its caller commits them with the queue admission, or alone. */
export interface AgentChannelStateCommit {
  /** Set after release. Later transactions commit on their own. */
  closed: boolean
  locks: Lock[]
  mutations: AgentStateCacheMutation[]
  state: StateAdapter
}

function hasChannelStateCommit(state: StateAdapter): state is AgentChannelStateCommitAdapter {
  // SAFETY: The State contract may include optional extension methods, checked below before use.
  return isRuntimeFunction((state as Partial<AgentChannelStateCommitAdapter>).commitWebhookState)
}

function channelStateLockLost(lock: Lock): Error {
  return new Error(`[vitehub] Channel State lock "${lock.threadId}" expired before its writes were committed.`)
}

function positiveDuration(value: number | undefined, fallback: number, name: string, allowZero = false): number {
  if (value === undefined) return fallback
  if (!isRuntimeNumber(value) || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`[vitehub] channelState.transaction() ${name} must be a ${allowZero ? "non-negative" : "positive"} finite number.`)
  }
  return value
}

/** Waits up to `waitMs` for a State lock, then throws, so the delivery retries later. */
export async function acquireChannelStateLock(state: StateAdapter, key: string, ttlMs: number = channelStateLockTtlMs, waitMs: number = channelStateLockWaitMs): Promise<Lock> {
  const deadline = Date.now() + waitMs
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    const lock = await state.acquireLock(key, ttlMs)
    if (lock) return lock
    if (Date.now() + delay > deadline) throw new Error(`[vitehub] Channel State lock "${key}" is still held after ${waitMs} ms.`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

/**
 * Writes `mutations`, and queues `delivery` when given, only while every lock is still held.
 * One transaction when the State implements `commitWebhookState` (SQLite and libSQL). Other States check the locks,
 * queue the delivery, then write: a crash between those steps keeps the delivery and loses the writes, so the retried
 * trigger decides again and the delivery ID deduplicates the admission.
 */
export async function commitChannelStateWrites(state: StateAdapter, writes: AgentChannelStateWrites): Promise<boolean> {
  if (hasChannelStateCommit(state)) return await state.commitWebhookState(writes)
  for (const lock of writes.locks) {
    if (!await state.extendLock(lock, channelStateLockTtlMs)) throw channelStateLockLost(lock)
  }
  let queued = true
  if (writes.delivery) {
    if (!hasAgentWebhookQueue(state)) throw new Error("[vitehub] Channel State writes with a delivery need a queue-capable State.")
    queued = await state.enqueueWebhookDelivery(writes.delivery)
  }
  if (queued) {
    for (const mutation of writes.mutations) {
      if (mutation.type === "delete") await state.delete(mutation.key)
      else await state.set(mutation.key, mutation.value)
    }
  }
  return queued
}

export function createAgentChannelStateCommit(state: StateAdapter): AgentChannelStateCommit {
  return { closed: false, locks: [], mutations: [], state }
}

/** Drops the staged writes and releases the locks. Later calls do nothing. */
export async function releaseAgentChannelStateCommit(commit: AgentChannelStateCommit | undefined): Promise<void> {
  if (!commit) return
  commit.closed = true
  const locks = commit.locks.splice(0)
  commit.mutations.length = 0
  await Promise.all(locks.map(lock => commit.state.releaseLock(lock).catch(() => undefined)))
}

/** Commits the staged writes now, because the trigger call was accepted without a queued delivery. */
export async function settleAgentChannelStateCommit(commit: AgentChannelStateCommit | undefined): Promise<void> {
  if (!commit) return
  try {
    if (commit.mutations.length) await commitChannelStateWrites(commit.state, { locks: commit.locks, mutations: commit.mutations })
  }
  finally {
    await releaseAgentChannelStateCommit(commit)
  }
}

/** Admits `delivery` to the webhook queue and commits the staged writes with it. */
export async function admitAgentChannelStateCommit<Options>(
  commit: AgentChannelStateCommit | undefined,
  webhookQueue: AgentWebhookQueue<Options>,
  registration: AgentWebhookQueueRegistration<Options>,
  delivery: AgentWebhookQueueDelivery,
): Promise<boolean> {
  try {
    if (!commit || commit.closed || (!commit.locks.length && !commit.mutations.length)) return await webhookQueue.admit(registration, delivery)
    if (commit.state !== registration.state) {
      // Two States cannot share a transaction. Queue first: a lost write repeats the decision, it does not lose the delivery.
      const queued = await webhookQueue.admit(registration, delivery)
      await settleAgentChannelStateCommit(commit)
      return queued
    }
    const writes = { locks: commit.locks, mutations: commit.mutations }
    return await webhookQueue.admit(registration, delivery, async queued => await commitChannelStateWrites(commit.state, { ...writes, delivery: queued }))
  }
  finally {
    await releaseAgentChannelStateCommit(commit)
  }
}

/**
 * `channelState.transaction(key, run)`: holds the key's lock while `run` reads `value` and stages `set()` or `delete()`.
 * A thrown error or a `Response` with status 400 or above writes nothing. With an open `commit`, the lock and the write
 * move into it, and the caller commits them with the queue admission. Without one, the write commits when `run` returns.
 */
export async function runChannelStateTransaction<T, R>(
  binding: AgentChannelStateBinding,
  commit: AgentChannelStateCommit | undefined,
  key: string,
  run: (state: AgentChannelStateTransaction<T>) => MaybePromise<R>,
  options: AgentChannelStateTransactionOptions = {},
): Promise<R> {
  if (!isRuntimeString(key) || !key) throw new TypeError("[vitehub] channelState.transaction() needs a non-empty key.")
  if (!isRuntimeFunction(run)) throw new TypeError("[vitehub] channelState.transaction() needs a callback.")
  const ttlMs = positiveDuration(options.ttlMs, channelStateLockTtlMs, "ttlMs")
  const waitMs = positiveDuration(options.waitMs, channelStateLockWaitMs, "waitMs", true)
  const { state } = binding
  const stateKey = `${binding.keyPrefix}${key}`
  const lockKey = `${stateKey}:transaction`
  const into = commit && !commit.closed && commit.state === state ? commit : undefined
  if (into?.locks.some(lock => lock.threadId === lockKey)) {
    throw new TypeError(`[vitehub] Channel State key "${key}" already has a transaction in this trigger call.`)
  }
  const lock = await acquireChannelStateLock(state, lockKey, ttlMs, waitMs)
  let write: AgentStateCacheMutation | undefined
  let result: R
  try {
    const value = await state.get<T>(stateKey)
    result = await run({
      key: stateKey,
      value: value ?? null,
      set(next) {
        write = { key: stateKey, type: "set", value: next }
      },
      delete() {
        write = { key: stateKey, type: "delete" }
      },
    })
  }
  catch (error) {
    await state.releaseLock(lock).catch(() => undefined)
    throw error
  }
  if (isResponse(result) && result.status >= 400) {
    await state.releaseLock(lock).catch(() => undefined)
    return result
  }
  if (into && !into.closed) {
    into.locks.push(lock)
    if (write) into.mutations.push(write)
    return result
  }
  await settleAgentChannelStateCommit({ closed: false, locks: [lock], mutations: write ? [write] : [], state })
  return result
}

/** The Channel State that trigger callbacks see. Transactions stage into `commit` while it is open. */
export function createAgentChannelState(binding: AgentChannelStateBinding, commit?: AgentChannelStateCommit): AgentChannelState {
  return {
    keyPrefix: binding.keyPrefix,
    state: binding.state,
    transaction: (key, run, options) => runChannelStateTransaction(binding, commit, key, run, options),
  }
}
