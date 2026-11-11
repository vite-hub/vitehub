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
  AuthRuntimeOptions,
  RegisteredAuth,
  ViteHubAuth,
} from "./types.ts"

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined

function hasRuntimeOptions(options: AuthRuntimeOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

function hasRequestRuntimeOptions(definition: AuthDefinition): boolean {
  if (typeof definition.options === "function") return true
  const runtime = definition.options.runtime
  return typeof runtime === "function" || trustsProxyHeaders(definition.options) || trustsProxyHeaders(runtime)
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

export function createBetterAuthOptions(
  definition: AuthDefinition,
  runtimeOptions: AuthRuntimeOptions = {},
): AuthBetterAuthRuntimeOptions {
  return resolveAuthOptions(definition, { runtimeOptions, env: envResolverFor(definition) }).providerOptions
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

export function getAuthForDefinition<TDefinition extends AuthDefinition>(
  definition: TDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): AuthFor<TDefinition> {
  if (hasRuntimeOptions(runtimeOptions)) {
    return createAuthenticationProvider<AuthFor<TDefinition>>(createBetterAuthOptions(definition, runtimeOptions))
  }

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

/**
 * The Better Auth instance of the app's Auth Definition for a request that can differ from the event's own, with
 * runtime options. Apps call `useAuth(event)`. The Console reads it through `@vite-hub/auth/runtime/console`.
 */
export function authForRequest(
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: ViteHubContext,
): RegisteredAuth {
  const definition = resolveDefaultDefinition()
  if (!hasRequestRuntimeOptions(definition) && !hasRuntimeOptions(runtimeOptions) && !hasConfiguredPublicUrl()) {
    return getAuthForDefinition(definition) as RegisteredAuth
  }
  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).providerOptions)
}
