import { agentDiagnostics } from "../agent-diagnostics.ts"
import type { Lock, StateAdapter } from "chat"

/** State storage that retains its data across process and host restarts. */
export interface DurableAgentStateAdapter extends StateAdapter {
  readonly durable: true
}

export type AgentStateCacheMutation = { key: string, type: "delete" } | { key: string, type: "set", value: unknown }

/** Cache mutations and the live lease check must commit in one backend transaction. */
export interface AtomicAgentStateLockAdapter extends StateAdapter {
  mutateWithLock(lock: Lock, mutations: readonly AgentStateCacheMutation[]): Promise<boolean>
  /**
   * Takes the lock and, only when it gets it, applies `mutations` and reads `keys`, in one request. Optional:
   * `acquireLockWith()` sends one request per step without it. On Cloudflare each request is a Durable Object request.
   */
  acquireLockWith?(threadId: string, ttlMs: number, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ lock: Lock | null, values: unknown[] }>
  /**
   * Applies `mutations` while the lease is live, releases the lock, then reads `keys`, in one request. `committed` is
   * `false` when the lease was lost, and the mutations then do not apply. Optional, like `acquireLockWith`.
   */
  releaseLockWith?(lock: Lock, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ committed: boolean, values: unknown[] }>
  /** Colocate cache and locks without changing existing cache keys or storage identity. */
  forCacheLocks?(): AtomicAgentStateLockAdapter
}

export function requireAtomicAgentStateLock(state: StateAdapter): AtomicAgentStateLockAdapter {
  // SAFETY: The State contract may include optional extension methods, checked below before use.
  const candidate = state as Partial<AtomicAgentStateLockAdapter>
  if (typeof candidate.mutateWithLock !== "function") {
    throw agentDiagnostics.AGENT_STATE_ATOMIC_LOCK_MISSING()
  }
  // SAFETY: The adapter explicitly implements the atomic mutation contract checked above.
  return candidate as AtomicAgentStateLockAdapter
}

/** Durable State retains Channel cursors across process and host restarts. */
export function isDurableAgentState(state: StateAdapter): state is DurableAgentStateAdapter {
  return typeof state === "object" && state !== null && "durable" in state && state.durable === true
}

/** Takes the lock, then applies `mutations` and reads `keys` when it got it. A missing key reads as `null`. */
export async function acquireLockWith(
  state: AtomicAgentStateLockAdapter,
  threadId: string,
  ttlMs: number,
  mutations: readonly AgentStateCacheMutation[],
  keys: readonly string[],
): Promise<{ lock: Lock | null, values: unknown[] }> {
  if (state.acquireLockWith) return await state.acquireLockWith(threadId, ttlMs, mutations, keys)
  return await acquireLockWithSeparateCalls(state, threadId, ttlMs, mutations, keys)
}

export async function acquireLockWithSeparateCalls(
  state: AtomicAgentStateLockAdapter,
  threadId: string,
  ttlMs: number,
  mutations: readonly AgentStateCacheMutation[],
  keys: readonly string[],
): Promise<{ lock: Lock | null, values: unknown[] }> {
  const lock = await state.acquireLock(threadId, ttlMs)
  if (!lock) return { lock, values: [] }
  try {
    if (!mutations.length || await state.mutateWithLock(lock, mutations)) {
      return { lock, values: await Promise.all(keys.map(key => state.get(key))) }
    }
  }
  catch (error) {
    await state.releaseLock(lock).catch(() => undefined)
    throw error
  }
  await state.releaseLock(lock)
  return { lock: null, values: [] }
}

/** Applies `mutations` under the lease, releases the lock, then reads `keys`. A missing key reads as `null`. */
export async function releaseLockWith(
  state: AtomicAgentStateLockAdapter,
  lock: Lock,
  mutations: readonly AgentStateCacheMutation[],
  keys: readonly string[],
): Promise<{ committed: boolean, values: unknown[] }> {
  if (state.releaseLockWith) return await state.releaseLockWith(lock, mutations, keys)
  return await releaseLockWithSeparateCalls(state, lock, mutations, keys)
}

export async function releaseLockWithSeparateCalls(
  state: AtomicAgentStateLockAdapter,
  lock: Lock,
  mutations: readonly AgentStateCacheMutation[],
  keys: readonly string[],
): Promise<{ committed: boolean, values: unknown[] }> {
  let committed: boolean
  try {
    committed = await state.mutateWithLock(lock, mutations)
  }
  finally {
    await state.releaseLock(lock)
  }
  return { committed, values: await Promise.all(keys.map(key => state.get(key))) }
}
