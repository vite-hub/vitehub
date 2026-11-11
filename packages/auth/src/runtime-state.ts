import type { ViteHubContext } from "@vite-hub/runtime"
import type { AuthAuthorization, AuthDefinition, AuthRequestInput, ViteHubAuth } from "./types.ts"

// The Vite plugin resets this state without loading Better Auth. Keep this module free of provider imports.
const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

export type AuthRuntimeEnvResolver = (event?: ViteHubContext) => Record<string, unknown>
export type AuthAccessIdentityResolver = (request: Request, event: AuthRequestInput, hasSession: boolean) => Promise<AuthAuthorization["user"] | Response | undefined>

export interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
  /** The request instances of each Auth Definition, by the key of their resolved options. Oldest first. */
  providers?: WeakMap<object, Map<string, ViteHubAuth>>
  /**
   * Set once by the generated Nitro plugin. It lives here, not in the server module, because a dev reload re-runs the
   * server module when the app's Auth Definition changes, and the plugin does not run again.
   */
  envResolver?: AuthRuntimeEnvResolver
  envResolvers?: WeakMap<object, AuthRuntimeEnvResolver>
  accessIdentityResolvers?: Map<string, AuthAccessIdentityResolver>
  /** The in-memory tables of each Auth Definition without a database, shared by all of its Better Auth instances. */
  memoryDatabases?: WeakMap<object, Record<string, unknown[]>>
  /** Serializes claim reservations across Auth instances in this process. */
  adminClaimQueues?: Map<string, Promise<boolean>>
}

/**
 * Marks the database that Auth adds to a Definition without one. It keeps rows in the memory of one process, so a value
 * that another instance must see, such as a one-time ticket, cannot live there.
 */
export const authProcessMemoryDatabase: unique symbol = Symbol.for("vitehub.auth.processMemoryDatabase")

/** Whether a Better Auth `database` option is the process memory database that Auth adds. */
export function isAuthProcessMemoryDatabase(database: unknown): boolean {
  return database instanceof Object && Reflect.get(database, authProcessMemoryDatabase) === true
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
  state.providers = undefined
}
