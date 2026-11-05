import type { AgentProviderStatus } from "../types.ts"

// Symbol.for lets the Agent runtime read the error from a status that another bundle of this package created.
const providerStatusErrorKey = Symbol.for("vitehub.agent.provider-status-error")

/**
 * Attaches the diagnostic that explains an unavailable status. The readiness check before an Invocation throws it
 * instead of a generic provider error. A symbol key keeps it out of JSON status reports.
 */
export function withProviderStatusError(status: AgentProviderStatus, error: Error): AgentProviderStatus {
  const result = { ...status }
  Reflect.defineProperty(result, providerStatusErrorKey, { enumerable: true, value: error })
  return result
}

export function readProviderStatusError(status: AgentProviderStatus): Error | undefined {
  const error: unknown = Reflect.get(status, providerStatusErrorKey)
  return error instanceof Error ? error : undefined
}
