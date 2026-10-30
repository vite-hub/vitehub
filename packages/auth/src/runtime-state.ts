import type { AuthAuthorization, AuthDefinition, AuthRequestInput, ViteHubAuth } from "./types.ts"

// The Vite plugin resets this state without loading Better Auth. Keep this module free of provider imports.
const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

export type AuthRuntimeEnvResolver = (event?: unknown) => Record<string, unknown>
export type AuthAccessIdentityResolver = (request: Request, event: AuthRequestInput, hasSession: boolean) => Promise<AuthAuthorization["user"] | Response | undefined>

export interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
  /**
   * Set once by the generated Nitro plugin. It lives here, not in the server module, because a dev reload re-runs the
   * server module when the app's Auth Definition changes, and the plugin does not run again.
   */
  envResolver?: AuthRuntimeEnvResolver
  envResolvers?: WeakMap<object, AuthRuntimeEnvResolver>
  accessIdentityResolvers?: Map<string, AuthAccessIdentityResolver>
}

export function getAuthRuntimeState(): AuthRuntimeState {
  // SAFETY: only this module writes the private `vitehub.auth.runtime` symbol, and it always stores an AuthRuntimeState.
  const globalScope = globalThis as typeof globalThis & {
    [authRuntimeStateKey]?: AuthRuntimeState
  }
  globalScope[authRuntimeStateKey] ??= {}
  globalScope[authRuntimeStateKey].envResolvers ??= new WeakMap()
  return globalScope[authRuntimeStateKey]
}

export function resetAuth(): void {
  const state = getAuthRuntimeState()
  state.auth = undefined
  state.definition = undefined
}
