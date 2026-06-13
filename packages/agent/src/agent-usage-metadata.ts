import type {
  AgentHarnessCredentialSource,
  AgentUsageCredentialSource,
} from "./types.ts"

interface AgentUsageMetadata {
  credentialSource?: AgentUsageCredentialSource
}

const agentUsageMetadataKey = "__vitehubUsageMetadata"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function harnessCredentialSourceMetadata(credentials: AgentHarnessCredentialSource | undefined): AgentUsageMetadata | undefined {
  if (!credentials) return undefined
  const source = typeof credentials.source === "string" ? credentials.source : undefined
  const label = typeof credentials.label === "string" ? credentials.label : undefined
  if (!source && !label) return undefined
  return {
    credentialSource: {
      ...(label ? { label } : {}),
      ...(source ? { source } : {}),
    },
  }
}

export function defineAgentUsageMetadata(result: unknown, metadata: AgentUsageMetadata | undefined): unknown {
  if (!result || typeof result !== "object" || !metadata) return result
  Object.defineProperty(result, agentUsageMetadataKey, {
    configurable: true,
    value: metadata,
  })
  return result
}

export function readAgentUsageMetadata(result: unknown, fallback?: unknown): AgentUsageMetadata | undefined {
  if (isRecord(result) && isRecord(result[agentUsageMetadataKey])) {
    return result[agentUsageMetadataKey] as AgentUsageMetadata
  }
  if (isRecord(fallback) && isRecord(fallback[agentUsageMetadataKey])) {
    return fallback[agentUsageMetadataKey] as AgentUsageMetadata
  }
}
