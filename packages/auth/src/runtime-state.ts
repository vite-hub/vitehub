import type { AuthDefinition, ViteHubAuth } from "./types.ts"

// The Vite plugin resets this state without loading Better Auth. Keep this module free of provider imports.
const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

export type AuthRuntimeEnvResolver = (event?: unknown) => Record<string, unknown>

export interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
  /**
   * Set once by the generated Nitro plugin. It lives here, not in the server module, because a dev reload re-runs the
   * server module when the app's Auth Definition changes, and the plugin does not run again.
   */
  envResolver?: AuthRuntimeEnvResolver
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
