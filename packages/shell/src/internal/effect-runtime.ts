import { createEffectBoundary, EffectBoundaryFailure } from "@vite-hub/internal/effect"

const boundary = createEffectBoundary({
  aggregateMessage: "[vitehub] Shell operation failed for multiple reasons.",
  interruptionMessage: "[vitehub] Shell operation was interrupted.",
})

export { EffectBoundaryFailure as ShellEffectFailure }
export const acquireShellResource = boundary.acquireWithCapturedRelease
export const closeShellScope = boundary.closeScopeWithCapturedReleases
export const runShellEffect = boundary.run
export const tryShellPromise = boundary.tryPromise
