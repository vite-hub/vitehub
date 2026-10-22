import { AsyncLocalStorage } from "node:async_hooks"

import type { TraceEvent } from "@vite-hub/runtime"

/** The Agent Invocation whose Driver or outcome hook is running. */
export interface AgentInvocationScope {
  readonly agentName?: string
  /** The journal record of the Invocation, when it has one. */
  readonly journal?: {
    readonly id: string
    readonly traceId: string | undefined
  }
  readonly runId?: string
  /** Records an event in the trace of the Invocation. */
  trace(event: TraceEvent): Promise<void>
}

const storageKey = Symbol.for("vitehub.agent.invocation-scope")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
// One store per process, so that two copies of the package see the same scope.
// SAFETY: Only this module writes the global slot, always with this storage type.
const storage = (runtimeGlobal[storageKey] ||= new AsyncLocalStorage<AgentInvocationScope>()) as AsyncLocalStorage<AgentInvocationScope>

/** Runs `callback` with `scope` as the active Invocation, so an Invocation that it starts becomes a child of `scope`. */
export function runInAgentInvocationScope<T>(scope: AgentInvocationScope, callback: () => T): T {
  return storage.run(scope, callback)
}

/** The Invocation whose Driver or outcome hook is running, if any. */
export function activeAgentInvocationScope(): AgentInvocationScope | undefined {
  return storage.getStore()
}

/** The trace that an Invocation without its own trace joins when it starts inside the active Invocation. */
export function parentInvocationTrace(): { id: string, parentId: string } | undefined {
  const journal = activeAgentInvocationScope()?.journal
  const traceId = journal?.traceId
  return journal && traceId ? { id: traceId, parentId: journal.id } : undefined
}

/** Attributes that name an Invocation: `<prefix>.id` (its record ID), `<prefix>.run.id` and `<prefix>.agent.name`. */
export function agentInvocationLinkAttributes(scope: AgentInvocationScope, prefix: "agent.invocation.child" | "agent.invocation.parent"): Record<string, string> {
  return {
    ...(scope.journal ? { [`${prefix}.id`]: scope.journal.id } : {}),
    ...(scope.runId ? { [`${prefix}.run.id`]: scope.runId } : {}),
    ...(scope.agentName ? { [`${prefix}.agent.name`]: scope.agentName } : {}),
  }
}
