import type { createProviderAgentAdapter, inspectAgentProvider } from "../provider-agent.ts"

/** The provider Agent runtime that `codexDriver()` and `claudeCodeDriver()` load on first use. */
export interface ProviderAgentRuntime {
  createProviderAgentAdapter: typeof createProviderAgentAdapter
  inspectAgentProvider: typeof inspectAgentProvider
}

export type ProviderAgentRuntimeLoader = () => Promise<ProviderAgentRuntime>

/**
 * Keys the provider Agent runtime loader on a provider Driver. Only the Driver factories set it,
 * so an app that never calls one does not bundle the provider runtime.
 * The registered symbol stays the same when a host loads this module more than once.
 */
// SAFETY: Symbol.for returns the registry symbol used by this module; the unique type prevents unrelated keys.
export const providerAgentRuntime: unique symbol = Symbol.for("vitehub.agent.providerAgentRuntime") as never
