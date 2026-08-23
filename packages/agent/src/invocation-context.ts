import { hasRuntimeType } from "./internal/runtime-type.ts"
import type { AgentInvocationContextStore } from "./types.ts"

export const agentInvocationRunId = Symbol.for("vitehub.agent.invocationRunId")

function isCallbackContextValue(id: string): boolean {
  return id !== "actor"
    && id !== "invoker"
    && id !== "chat"
    && !id.startsWith("agent.")
    && !id.startsWith("channel.delivery.")
    && !id.startsWith("chat.")
    && !id.startsWith("workspace.")
}

function* callbackContextEntries(context: AgentInvocationContextStore): IterableIterator<[string, unknown]> {
  for (const entry of context.entries()) {
    if (isCallbackContextValue(entry[0])) yield entry
  }
}

export function agentInvocationCallbackContextValues(context: AgentInvocationContextStore): Record<string, unknown> {
  return Object.fromEntries(callbackContextEntries(context))
}

export function agentInvocationSourceContext(context: AgentInvocationContextStore): AgentInvocationContextStore {
  return {
    entries: () => callbackContextEntries(context),
    get: context.get.bind(context),
    has: context.has.bind(context),
    set: context.set.bind(context),
    toJSON: context.toJSON.bind(context),
  }
}

function assertContextId(id: unknown): asserts id is string {
  if (!hasRuntimeType(id, "string") || !id.trim()) {
    throw new TypeError("[vitehub] Invocation context values require a non-empty string id.")
  }
  if (!/^[a-z][a-z0-9-_.:]*$/i.test(id)) {
    throw new TypeError(`[vitehub] Invocation context id "${id}" must be a stable identifier.`)
  }
}

export function createAgentInvocationContextStore(initial?: Record<string, unknown>): AgentInvocationContextStore {
  const values = new Map<string, unknown>()

  for (const [id, value] of Object.entries(initial || {})) {
    values.set(id, value)
  }

  return {
    entries() {
      return values.entries()
    },
    get(id: string): unknown {
      return values.get(id)
    },
    has(id: string): boolean {
      return values.has(id)
    },
    set(id: string, value: unknown, options?: { overwrite?: boolean }): void {
      assertContextId(id)
      if (values.has(id) && !options?.overwrite) {
        throw new Error(`[vitehub] Invocation context value "${id}" is already set.`)
      }
      values.set(id, value)
    },
    toJSON(): Record<string, unknown> {
      return Object.fromEntries(values)
    },
  }
}
