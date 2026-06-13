import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"

import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthDefinitionOptions,
  AuthRuntimeOptions,
  ViteHubAuth,
} from "./types.ts"

function hasRuntimeOptions(options: AuthRuntimeOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
}

function getAuthRuntimeState(): AuthRuntimeState {
  const globalScope = globalThis as typeof globalThis & {
    [authRuntimeStateKey]?: AuthRuntimeState
  }
  globalScope[authRuntimeStateKey] ??= {}
  return globalScope[authRuntimeStateKey]
}

function resolveDefaultDefinition(): AuthDefinition {
  if (!discoveredDefinition) {
    throw new Error("[vitehub] No Auth Definition was discovered. Add `server/auth.ts` or `server.auth.ts`.")
  }
  return discoveredDefinition
}

export function createBetterAuthOptions<const TOptions extends AuthDefinitionOptions>(
  definition: AuthDefinition<TOptions>,
  runtimeOptions: AuthRuntimeOptions = {},
): AuthBetterAuthRuntimeOptions<TOptions> {
  const {
    database: _database,
    route: _route,
    secondaryStorage: _secondaryStorage,
    ...options
  } = definition.options

  return {
    ...options,
    basePath: normalizeAuthBasePath(options.basePath),
    ...runtimeOptions,
  } as AuthBetterAuthRuntimeOptions<TOptions>
}

export function createAuth<const TOptions extends AuthDefinitionOptions>(
  definition: AuthDefinition<TOptions>,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth<AuthBetterAuthRuntimeOptions<TOptions>> {
  return betterAuth(createBetterAuthOptions(definition, runtimeOptions)) as ViteHubAuth<AuthBetterAuthRuntimeOptions<TOptions>>
}

export function createAuthHandler<const TOptions extends AuthDefinitionOptions>(
  definition: AuthDefinition<TOptions>,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth<AuthBetterAuthRuntimeOptions<TOptions>>["handler"] {
  return createAuth(definition, runtimeOptions).handler
}

export function resetAuth(): void {
  const state = getAuthRuntimeState()
  state.auth = undefined
  state.definition = undefined
}

export function getAuthForDefinition(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth {
  if (hasRuntimeOptions(runtimeOptions)) {
    return createAuth(definition, runtimeOptions) as unknown as ViteHubAuth
  }

  const state = getAuthRuntimeState()
  if (!state.auth || state.definition !== definition) {
    state.auth = createAuth(definition) as unknown as ViteHubAuth
    state.definition = definition
  }
  return state.auth
}

export function getAuth(runtimeOptions?: AuthRuntimeOptions): ViteHubAuth {
  return getAuthForDefinition(resolveDefaultDefinition(), runtimeOptions)
}

export const auth = new Proxy({}, {
  get(_target, property, receiver) {
    return Reflect.get(getAuth() as object, property, receiver)
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(getAuth() as object, property)
  },
  has(_target, property) {
    return Reflect.has(getAuth() as object, property)
  },
  ownKeys() {
    return Reflect.ownKeys(getAuth() as object)
  },
}) as ViteHubAuth
