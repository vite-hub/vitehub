import type {
  AgentInvocationController,
  AgentInvocationControlOutcome,
  AgentInvocationInputMode,
  AgentInvocationInputSupport,
} from "../agent-invocation.ts"
import type { AgentRunInput, MaybePromise } from "../types.ts"

const invocationControlId = Symbol("vitehub.agentInvocationControlId")

type InvocationControlContext = {
  [invocationControlId]?: string
  run?: { runId?: string }
}

export function agentInvocationControlId(context: InvocationControlContext): string | undefined {
  return context[invocationControlId] ?? context.run?.runId
}

export function ownedAgentInvocationControlId(context: InvocationControlContext): string | undefined {
  return context[invocationControlId]
}

export function withAgentInvocationControlId<TContext extends object>(context: TContext, id: string): TContext {
  return { ...context, [invocationControlId]: id }
}

interface AgentInvocationInputHandler {
  sendInput: (
    input: AgentRunInput,
    options: { mode: AgentInvocationInputMode },
  ) => MaybePromise<AgentInvocationControlOutcome>
  support: Partial<AgentInvocationInputSupport>
}

interface ActiveAgentInvocation {
  controller: AgentInvocationController
  result: Promise<unknown>
}

const invocationInputHandlersKey = Symbol.for("vitehub.agentInvocationInputHandlers")
const activeInvocationOwnersKey = Symbol.for("vitehub.activeInvocationOwners")
const scopedActiveInvocationOwners = new WeakMap<object, Map<string, ActiveAgentInvocation>>()

function globalMap<T>(key: symbol): Map<string, T> {
  const root = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = root[key]
  if (existing instanceof Map) return existing as Map<string, T>
  const registry = new Map<string, T>()
  root[key] = registry
  return registry
}

export function registerAgentInvocationInputHandler(
  invocationId: string,
  handler: AgentInvocationInputHandler,
): () => void {
  const handlers = globalMap<AgentInvocationInputHandler>(invocationInputHandlersKey)
  handlers.set(invocationId, handler)
  return () => {
    if (handlers.get(invocationId) === handler) handlers.delete(invocationId)
  }
}

export function agentInvocationInputSupport(invocationId: string): Partial<AgentInvocationInputSupport> {
  return globalMap<AgentInvocationInputHandler>(invocationInputHandlersKey).get(invocationId)?.support || {}
}

export async function sendAgentInvocationInput(
  invocationId: string,
  input: AgentRunInput,
  options: { mode: AgentInvocationInputMode },
): Promise<AgentInvocationControlOutcome> {
  const handler = globalMap<AgentInvocationInputHandler>(invocationInputHandlersKey).get(invocationId)
  return handler ? await handler.sendInput(input, options) : "unavailable"
}

export function registerActiveAgentInvocation(
  ownerKey: string,
  controller: AgentInvocationController,
  result: Promise<unknown>,
  scope?: object,
): () => void {
  let owners = scope ? scopedActiveInvocationOwners.get(scope) : undefined
  if (!owners) {
    owners = scope ? new Map<string, ActiveAgentInvocation>() : globalMap<ActiveAgentInvocation>(activeInvocationOwnersKey)
    if (scope) scopedActiveInvocationOwners.set(scope, owners)
  }
  const active = { controller, result }
  owners.set(ownerKey, active)
  return () => {
    if (owners.get(ownerKey) === active) owners.delete(ownerKey)
  }
}

export function activeAgentInvocation(ownerKey: string, scope?: object): ActiveAgentInvocation | undefined {
  return (scope ? scopedActiveInvocationOwners.get(scope) : globalMap<ActiveAgentInvocation>(activeInvocationOwnersKey))?.get(ownerKey)
}
