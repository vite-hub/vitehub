import { createEffectBoundary, EffectBoundaryFailure } from "@vite-hub/internal/effect"

const boundary = createEffectBoundary({
  aggregateMessage: "[vitehub] Agent operation failed for multiple reasons.",
  interruptionMessage: "[vitehub] Agent operation was interrupted.",
})

export { EffectBoundaryFailure as AgentEffectFailure }
export const acquireAgentResource = boundary.acquireWithCapturedRelease
export const agentEffectCauseValues = boundary.causeValues
export const closeAgentResources = boundary.closeScopeWithCapturedReleases
export const runAgentEffect = boundary.run
export const tryAgentPromise = boundary.tryPromise
