import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
import { resolveAuthOptions, trustsProxyHeaders } from "./runtime-options.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"
import { withSessionMarker } from "./session-marker.ts"
import { withClientAddress } from "./client-address.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { AuthRuntimeEnvResolver } from "./runtime-state.ts"
import type { PublicUrlConfig, ViteHubContext } from "@vite-hub/runtime"
import type {
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthFor,
  RegisteredAuth,
  ViteHubAuth,
} from "./types.ts"

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined

function hasRequestRuntimeOptions(definition: AuthDefinition): boolean {
  return typeof definition.options === "function" || trustsProxyHeaders(definition.options)
}

function hasConfiguredPublicUrl(): boolean {
  return typeof __VITEHUB_PUBLIC_URL__ !== "undefined"
    && Boolean(__VITEHUB_PUBLIC_URL__?.url || Object.keys(__VITEHUB_PUBLIC_URL__?.agents ?? {}).length)
}

export function envResolverFor(definition: AuthDefinition): AuthRuntimeEnvResolver | undefined {
  return getAuthRuntimeState().envResolvers?.get(definition as object) ?? getAuthRuntimeState().envResolver
}

export function resolveDefaultDefinition(): AuthDefinition {
  if (!discoveredDefinition) {
    throw authErrorDiagnostics.AUTH_R0005({ message: "[vitehub] No Auth Definition was discovered. Add `server/auth.ts` or `server.auth.ts`." })
  }
  return discoveredDefinition
}

export function createBetterAuthOptions(definition: AuthDefinition): AuthBetterAuthRuntimeOptions {
  return resolveAuthOptions(definition, { env: envResolverFor(definition) }).providerOptions
}

export function createAuthenticationProvider<TAuth = ViteHubAuth>(options: AuthBetterAuthRuntimeOptions): TAuth {
  try {
    // SAFETY: callers pass the options of the Auth Definition that TAuth is inferred from.
    return withSessionMarker(withClientAddress(betterAuth(options))) as TAuth
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-auth-for-request")
  }
}

export function getAuthForDefinition<TDefinition extends AuthDefinition>(definition: TDefinition): AuthFor<TDefinition> {
  return cachedAuth(definition)
}

function cachedAuth<TAuth>(definition: AuthDefinition): TAuth {
  const state = getAuthRuntimeState()
  if (!state.auth || state.definition !== definition) {
    state.auth = createAuthenticationProvider(createBetterAuthOptions(definition))
    state.definition = definition
  }
  // SAFETY: state.auth is the instance of `definition`, the Auth Definition that TAuth is inferred from.
  return state.auth as TAuth
}

// Better Auth builds its endpoints and context once per instance. Keep a few instances of one Definition, because a
// callback that creates new functions or adapters on each request gives a new key on each request.
const maxRequestProviders = 16

/** The instance for these resolved options. Requests with an equal key share it; others get their own. */
export function requestProvider(
  definition: AuthDefinition,
  resolved: { readonly providerKey: string | undefined, readonly providerOptions: AuthBetterAuthRuntimeOptions },
): ViteHubAuth {
  const key = resolved.providerKey
  if (key === undefined) return createAuthenticationProvider(resolved.providerOptions)
  const state = getAuthRuntimeState()
  state.providers ??= new WeakMap()
  let providers = state.providers.get(definition)
  if (!providers) state.providers.set(definition, providers = new Map())
  const cached = providers.get(key)
  if (cached) {
    providers.delete(key)
    providers.set(key, cached)
    return cached
  }
  const auth = createAuthenticationProvider<ViteHubAuth>(resolved.providerOptions)
  providers.set(key, auth)
  if (providers.size > maxRequestProviders) providers.delete(providers.keys().next().value!)
  // A failed setup is not kept: the next request builds the instance again.
  const owner = providers
  void (async () => {
    try {
      await auth.$context
    }
    catch {
      if (owner.get(key) === auth) owner.delete(key)
    }
  })()
  return auth
}

/**
 * The Better Auth instance of the app's Auth Definition for a request that can differ from the event's own. Apps call
 * `useAuth(event)`. The Console reads it through `@vite-hub/auth/runtime/console`.
 */
export function authForRequest(
  request: Pick<Request, "headers" | "url">,
  event?: ViteHubContext,
): RegisteredAuth {
  const definition = resolveDefaultDefinition()
  if (!hasRequestRuntimeOptions(definition) && !hasConfiguredPublicUrl()) {
    return getAuthForDefinition(definition) as RegisteredAuth
  }
  return requestProvider(definition, resolveAuthOptions(definition, { request, event, env: envResolverFor(definition) })) as RegisteredAuth
}
