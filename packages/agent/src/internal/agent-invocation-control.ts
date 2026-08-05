import type {
  AgentInvocationController,
  AgentInvocationControlOutcome,
  AgentInvocationInputMode,
  AgentInvocationInputSupport,
} from "../agent-invocation.ts"
import type { AgentRunInput, MaybePromise } from "../types.ts"

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
): () => void {
  const owners = globalMap<ActiveAgentInvocation>(activeInvocationOwnersKey)
  const active = { controller, result }
  owners.set(ownerKey, active)
  return () => {
    if (owners.get(ownerKey) === active) owners.delete(ownerKey)
  }
}

export function activeAgentInvocation(ownerKey: string): ActiveAgentInvocation | undefined {
  return globalMap<ActiveAgentInvocation>(activeInvocationOwnersKey).get(ownerKey)
}
