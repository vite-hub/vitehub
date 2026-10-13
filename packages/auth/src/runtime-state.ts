import type { AuthDefinition, ViteHubAuth } from "./types.ts"

// The Vite plugin resets this state without loading Better Auth. Keep this module free of provider imports.
const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

export interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
}

export function getAuthRuntimeState(): AuthRuntimeState {
  // SAFETY: only this module writes the private `vitehub.auth.runtime` symbol, and it always stores an AuthRuntimeState.
  const globalScope = globalThis as typeof globalThis & {
    [authRuntimeStateKey]?: AuthRuntimeState
  }
  globalScope[authRuntimeStateKey] ??= {}
  return globalScope[authRuntimeStateKey]
}

export function resetAuth(): void {
  const state = getAuthRuntimeState()
  state.auth = undefined
  state.definition = undefined
}
