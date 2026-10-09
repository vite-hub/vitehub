import type { Lock, StateAdapter } from "chat"
import { isRuntimeFunction, isRuntimeObject } from "./runtime-value.ts"

/** State storage that retains its data across process and host restarts. */
export interface DurableAgentStateAdapter extends StateAdapter {
  readonly durable: true
}

export type AgentStateCacheMutation = { key: string, type: "delete" } | { key: string, type: "set", value: unknown }

/** Cache mutations and the live lease check must commit in one backend transaction. */
export interface AtomicAgentStateLockAdapter extends StateAdapter {
  mutateWithLock(lock: Lock, mutations: readonly AgentStateCacheMutation[]): Promise<boolean>
  /** Colocate cache and locks without changing existing cache keys or storage identity. */
  forCacheLocks?(): AtomicAgentStateLockAdapter
}

export function requireAtomicAgentStateLock(state: StateAdapter): AtomicAgentStateLockAdapter {
  // SAFETY: The State contract may include optional extension methods, checked below before use.
  const candidate = state as Partial<AtomicAgentStateLockAdapter>
  if (!isRuntimeFunction(candidate.mutateWithLock)) {
    throw new Error("[vitehub] This operation requires State with atomic lease-fenced cache mutations (mutateWithLock).")
  }
  // SAFETY: The adapter explicitly implements the atomic mutation contract checked above.
  return candidate as AtomicAgentStateLockAdapter
}

/** Durable State retains Channel cursors across process and host restarts. */
export function isDurableAgentState(state: StateAdapter): state is DurableAgentStateAdapter {
  return isRuntimeObject(state) && "durable" in state && state.durable === true
}
