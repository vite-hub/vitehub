// Generated startup code imports this module. Keep it free of Better Auth imports: `@vite-hub/auth/server` loads
// Better Auth, and startup code imports it only when a request needs an Auth instance.
import { canonicalAccessPath, resolveAccessRoutePath } from "../application-path.ts"
import { unwrapAuthRequest } from "../request.ts"
import { getAuthRuntimeState } from "../runtime-state.ts"

import type { AuthAccessIdentityResolver, AuthRuntimeEnvResolver } from "../runtime-state.ts"
import type { AuthDefinition, AuthRequestInput, ResolvedAuthAccessRoute } from "../types.ts"

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined, definition?: AuthDefinition): void {
  const state = getAuthRuntimeState()
  if (definition) state.envResolvers?.set(definition as object, resolver as AuthRuntimeEnvResolver)
  else state.envResolver = resolver
}

/**
 * Let a trusted server integration authenticate one exact mounted path without a browser session.
 * Resolved users still pass every matching Auth access route's authorize callback, with an empty session.
 */
export function setAuthAccessIdentityResolver(path: string, resolver: AuthAccessIdentityResolver | undefined): void {
  const state = getAuthRuntimeState()
  state.accessIdentityResolvers ??= new Map()
  if (resolver) state.accessIdentityResolvers.set(path, resolver)
  else state.accessIdentityResolvers.delete(path)
}

/**
 * The Nitro route `meta` of a handler that checks its own access, such as the ViteHub Console route. The access routes
 * leave a request to the handler that Nitro routed it to when that handler has this meta, whatever its path and method.
 * The exception follows the dispatch, so an app route file on the same path keeps the access routes.
 */
export const authAccessHandlerMeta: Readonly<{ vitehubAuthAccess: "handler" }> = Object.freeze({ vitehubAuthAccess: "handler" })

/** Whether Nitro routed the request event to a handler with `authAccessHandlerMeta`. A plain Request has no route. */
function routedToAccessHandler(input: AuthRequestInput): boolean {
  if (!("context" in input) || !(input.context instanceof Object)) return false
  const route: unknown = Reflect.get(input.context, "matchedRoute")
  const meta: unknown = route instanceof Object ? Reflect.get(route, "meta") : undefined
  return meta instanceof Object && Reflect.get(meta, "vitehubAuthAccess") === authAccessHandlerMeta.vitehubAuthAccess
}

export interface AuthAccessRouteMatch {
  index: number
  authorize: boolean
}

/** Return a function that lists the access routes that match a request, in Definition order. */
export function createAuthAccessRouteMatcher(routes: readonly ResolvedAuthAccessRoute[]): (input: AuthRequestInput) => AuthAccessRouteMatch[] {
  const rules = routes.map((route, index) => ({
    index,
    authorize: route.authorize === true,
    method: route.method?.toUpperCase(),
    // Request URLs keep the application base path, so match each route below it.
    ...resolveAccessRoutePath(route.route),
  }))

  return (input) => {
    if (routedToAccessHandler(input)) return []
    const request = unwrapAuthRequest(input)
    // Match the path that the Nitro router reads, so that no spelling of a guarded path reaches its handler unguarded.
    const pathname = canonicalAccessPath(new URL(request.url).pathname)
    const method = request.method.toUpperCase()
    return rules
      .filter(rule =>
        // H3 runs a GET handler for a HEAD request, so a GET rule also guards HEAD.
        (!rule.method || rule.method === method || (rule.method === "GET" && method === "HEAD"))
        && (pathname === rule.path || (rule.recursive && (rule.path === "" || pathname.startsWith(`${rule.path}/`)))))
      .map(rule => ({ index: rule.index, authorize: rule.authorize }))
  }
}

type AuthAccessHandler = (input: AuthRequestInput) => Promise<Response | undefined>

/**
 * The access middleware of generated hosts. A request that no access route matches returns without loading `load()`,
 * so the server starts without Better Auth.
 */
export function createLazyAuthAccessHandler(
  routes: readonly ResolvedAuthAccessRoute[],
  load: () => Promise<{ createAuthAccessHandler: (routes: readonly ResolvedAuthAccessRoute[]) => AuthAccessHandler }>,
): AuthAccessHandler {
  const match = createAuthAccessRouteMatcher(routes)
  let handler: Promise<AuthAccessHandler> | undefined
  return async (input) => {
    if (match(input).length === 0) return
    handler ??= load().then(module => module.createAuthAccessHandler(routes)).catch((error: unknown) => {
      handler = undefined
      throw error
    })
    return await (await handler)(input)
  }
}
