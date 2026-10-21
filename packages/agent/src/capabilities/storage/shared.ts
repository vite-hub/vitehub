import type {
  AgentCapabilityMode,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  MaybePromise,
} from "../../types.ts"
import { agentDiagnostics } from "../../agent-diagnostics.ts"

export type StorageToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface PrimitiveStorageCapabilityOptions {
  mode?: AgentCapabilityMode
  policy?: StorageToolPolicy
  store?: string
}

export function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw agentDiagnostics.AGENT_R0229({ message: `[vitehub] ${label} must be a non-empty string.` })
  }
  return value
}

export function method<T extends (...args: never[]) => unknown>(handle: unknown, primitive: string, name: string): T {
  const fn = typeof handle === "object" && handle !== null ? (handle as Record<string, unknown>)[name] : undefined
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
  if (typeof storeFn !== "function") throw agentDiagnostics.AGENT_R0231({ message: `[vitehub] ${primitive} Capability store selection requires the ${primitive.toLowerCase()} primitive to expose store().` })
  return storeFn.call(handle, store)
}
