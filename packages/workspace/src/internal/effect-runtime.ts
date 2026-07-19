import { createEffectBoundary, EffectBoundaryFailure } from "@vite-hub/internal/effect"

const boundary = createEffectBoundary({
  aggregateMessage: "[vitehub] Workspace operation failed for multiple reasons.",
  interruptionMessage: "[vitehub] Workspace operation was interrupted.",
})

export { EffectBoundaryFailure as WorkspaceEffectFailure }
export const acquireWorkspaceResource = boundary.acquireWithCapturedRelease
export const closeWorkspaceResources = boundary.closeScopeWithCapturedReleases
export const runWorkspaceEffect = boundary.run
export const tryWorkspacePromise = boundary.tryPromise
export const workspaceEffectCauseValues = boundary.causeValues
