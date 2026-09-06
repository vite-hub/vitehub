import type {
  AgentCapabilityContext,
  AgentCapabilityMode,
  AgentToolDefinition,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  MaybePromise,
} from "../../types.ts"
import { agentDiagnostics } from "../../agent-diagnostics.ts"

export type JsonSchema = Record<string, unknown>
export type StorageToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface PrimitiveStorageCapabilityOptions {
  mode?: AgentCapabilityMode
  policy?: StorageToolPolicy
  store?: string
}

export function createTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition {
  if (!tool || typeof tool !== "object") {
    throw agentDiagnostics.AGENT_R0226({ message: "[vitehub] tool definitions must be objects." })
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw agentDiagnostics.AGENT_R0227({ message: "[vitehub] tool definitions require a tool name." })
  }
  return tool as AgentToolDefinition
}

export function jsonObjectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    type: "object",
  }
}

export function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  const value = typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
  if (!value) throw agentDiagnostics.AGENT_R0228({ message: `[vitehub] Capability "${name}" requires the ${name} primitive to be configured.` })
  return value
}

export function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw agentDiagnostics.AGENT_R0229({ message: `[vitehub] ${label} must be a non-empty string.` })
  }
  return value
}

export function method<T extends (...args: never[]) => unknown>(handle: unknown, primitive: string, name: string): T {
  const fn = typeof handle === "object" && handle !== null ? (handle as Record<string, unknown>)[name] : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider handles expose optional methods that must be callable before binding.
  if (typeof fn !== "function") throw agentDiagnostics.AGENT_R0230({ message: `[vitehub] ${primitive} primitive does not expose ${name}().` })
  return fn.bind(handle) as T
}

export async function storageValue<T>(result: MaybePromise<T | [Error, undefined] | [null, T]>): Promise<T> {
  const resolved = await result
  if (!Array.isArray(resolved) || resolved.length !== 2 || (resolved[0] !== null && !(resolved[0] instanceof Error))) {
    return resolved as T
  }
  if (resolved[0]) throw resolved[0]
  return resolved[1]
}

export function selectStore(handle: unknown, primitive: "Blob" | "KV", store?: string): unknown {
  if (!store) return handle
  const storeFn = typeof handle === "object" && handle !== null ? (handle as { store?: unknown }).store : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider handles expose optional methods that must be callable before binding.
  if (typeof storeFn !== "function") throw agentDiagnostics.AGENT_R0231({ message: `[vitehub] ${primitive} Capability store selection requires the ${primitive.toLowerCase()} primitive to expose store().` })
  return storeFn.call(handle, store)
}
