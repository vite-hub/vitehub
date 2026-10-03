import type { AgentInvocationStore } from "../invocations.ts"
import { Diagnostic } from "nostics"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isRuntimeRecord } from "./runtime-type.ts"

/**
 * Agent Driver that runs a journaled Invocation, and whether ViteHub can stop it.
 *
 * `enforced` is `true` when the Driver stops its work when the Invocation abort
 * signal aborts. A custom `run` Driver receives the signal, but ViteHub cannot
 * stop the handler.
 */
export interface AgentInvocationCancellationDriver {
  enforced: boolean
  name: string
}

interface AgentInvocationCancellationHandle {
  abort: (reason: unknown) => void
  driver?: () => AgentInvocationCancellationDriver | undefined
  ownerId: string
}

export interface LocalAgentInvocationCancellation {
  aborted: boolean
  ownerIds: readonly string[]
  notEnforcedBy?: string
  notEnforcedByOwners?: readonly { ownerId: string, name: string }[]
}

const cancellationHandlesKey = Symbol.for("vitehub.agentInvocationCancellations")

export const agentInvocationCancellationCode = "AGENT_R0970"
const cancellationInvocationId = Symbol.for("vitehub.agentInvocationCancellationId")
const observedCancellationFailures = new WeakMap<object, Set<string>>()

/** Retains the owner-observed cancellation identity for genuine abort failures. */
export function markAgentInvocationCancellationFailure(error: unknown, reason: unknown): void {
  if (!isRuntimeRecord(error)) return
  if (!(reason instanceof Diagnostic) || reason.code !== agentInvocationCancellationCode) return
  const id: unknown = Reflect.get(reason, cancellationInvocationId)
  if (!hasRuntimeType(id, "string")) return
  const ids = observedCancellationFailures.get(error) ?? new Set<string>()
  ids.add(id)
  observedCancellationFailures.set(error, ids)
}

function handles(owner: AgentInvocationStore): Map<string, Set<AgentInvocationCancellationHandle>> {
  // SAFETY: The registry uses a module-owned global symbol; unknown values are checked before use.
  const root = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = root[cancellationHandlesKey]
  // SAFETY: This module owns the global symbol and stores only this store-keyed registry there.
  const owners = existing instanceof WeakMap ? existing as WeakMap<AgentInvocationStore, Map<string, Set<AgentInvocationCancellationHandle>>> : new WeakMap<AgentInvocationStore, Map<string, Set<AgentInvocationCancellationHandle>>>()
  root[cancellationHandlesKey] = owners
  let registry = owners.get(owner)
  if (!registry) {
    registry = new Map<string, Set<AgentInvocationCancellationHandle>>()
    owners.set(owner, registry)
  }
  return registry
}

/**
 * Registers the abort handle of a running journaled Invocation in this process.
 * The registry lives on `globalThis`, so separate module instances in one process share it.
 */
export function registerAgentInvocationCancellation(owner: AgentInvocationStore, id: string, handle: AgentInvocationCancellationHandle): () => void {
  const registry = handles(owner)
  const entries = registry.get(id) ?? new Set<AgentInvocationCancellationHandle>()
  entries.add(handle)
  registry.set(id, entries)
  return () => {
    const current = registry.get(id)
    if (!current) return
    current.delete(handle)
    if (current.size === 0) registry.delete(id)
  }
}

/** Aborts every run in this process that holds the journaled Invocation. */
export function abortLocalAgentInvocation(owner: AgentInvocationStore, id: string, reason: unknown): LocalAgentInvocationCancellation {
  const entries = [...handles(owner).get(id) ?? []]
  for (const entry of entries) entry.abort(reason)
  const notEnforcedByOwners = entries.flatMap(entry => {
    const driver = entry.driver?.()
    return driver && !driver.enforced ? [{ ownerId: entry.ownerId, name: driver.name }] : []
  })
  const notEnforcedBy = notEnforcedByOwners[0]?.name
  return {
    aborted: entries.length > 0,
    ownerIds: entries.map(entry => entry.ownerId),
    ...(notEnforcedBy ? { notEnforcedBy } : {}),
    ...(notEnforcedByOwners.length > 0 ? { notEnforcedByOwners } : {}),
  }
}

export function agentInvocationCancellationDriver(driver: { kind: "ask" | "model" | "provider" | "run", provider?: string }): AgentInvocationCancellationDriver {
  if (driver.kind === "provider") return { enforced: true, name: driver.provider || "provider" }
  if (driver.kind === "run") return { enforced: false, name: "run" }
  return { enforced: true, name: driver.kind }
}

export function createAgentInvocationCancellationError(id: string): Error {
  const error = agentDiagnostics.AGENT_R0970({ message: `[vitehub] Cancellation was requested for Agent Invocation ${JSON.stringify(id)}.` })
  Object.defineProperty(error, cancellationInvocationId, { value: id })
  return error
}

/** Recognizes genuine abort errors across realms without accepting abort-shaped records. */
export function isAgentInvocationAbortError(error: unknown, names: readonly string[] = ["AbortError", "CanceledError"]): boolean {
  if (!isRuntimeRecord(error)) return false
  try {
    const nativeIsError: unknown = Reflect.get(Error, "isError")
    let branded = hasRuntimeType(nativeIsError, "function")
      ? nativeIsError(error) === true
      : error instanceof Error || (!(Symbol.toStringTag in error) && Object.prototype.toString.call(error) === "[object Error]")
    if (!branded && hasRuntimeType(globalThis.DOMException, "function")) {
      const nameGetter = Object.getOwnPropertyDescriptor(globalThis.DOMException.prototype, "name")?.get
      try {
        branded = Boolean(nameGetter && hasRuntimeType(nameGetter.call(error), "string"))
      }
      catch {}
    }
    const name: unknown = Reflect.get(error, "name")
    return branded && hasRuntimeType(name, "string") && names.includes(name)
  }
  catch {
    return false
  }
}

/** True when the error, its causes, or aggregate failures contain cancellation for the selected Invocation. */
export function isAgentInvocationCancellationError(error: unknown, id?: string): boolean {
  const seen = new Set<unknown>()
  const pending = [error]
  while (pending.length > 0) {
    const current = pending.pop()
    try {
      if (!isRuntimeRecord(current) || seen.has(current)) continue
      seen.add(current)
      const observed = observedCancellationFailures.get(current)
      if (observed && (id === undefined ? observed.size > 0 : observed.has(id))) return true
      if (current instanceof Diagnostic && current.code === agentInvocationCancellationCode
        && (id === undefined || Reflect.get(current, cancellationInvocationId) === id)) return true
      pending.push(current.cause)
      // Wrappers and aggregates may come from another realm; only the matched reason needs our identity.
      const errors: unknown = current.errors
      if (Array.isArray(errors)) pending.push(...errors)
    } catch {
      // An unreadable error must not replace the original Invocation failure.
    }
  }
  return false
}
