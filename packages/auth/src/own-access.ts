// The root entry and the generated access middleware import this module. Keep it free of Better Auth imports.
import { ownAccessHandlerMeta, ownAccessRouteMeta } from "@vite-hub/internal/nitro-kit"
import { isRecord } from "@vite-hub/internal/object"

import type { AuthRequestInput } from "./types.ts"

/**
 * The Nitro route `meta` of a handler that checks its own access, such as the ViteHub Console route. The access routes
 * leave a request to the handler that Nitro routed it to when that handler has this meta, whatever its path and method.
 * The exception follows the dispatch, so an app route file on the same path keeps the access routes.
 */
export const authAccessHandlerMeta: Readonly<{ vitehubAuthAccess: "handler" }> = ownAccessHandlerMeta

function matchedRouteMeta(input: AuthRequestInput): Record<string, unknown> | undefined {
  if (!("context" in input) || !isRecord(input.context)) return undefined
  const route = input.context.matchedRoute
  return isRecord(route) && isRecord(route.meta) ? route.meta : undefined
}

/** Whether Nitro routed the request event to a handler with `authAccessHandlerMeta`. A plain Request has no route. */
export function routedToAccessHandler(input: AuthRequestInput): boolean {
  const meta = matchedRouteMeta(input)
  return meta?.vitehubAuthAccess === authAccessHandlerMeta.vitehubAuthAccess
}

/**
 * Whether Nitro routed the request event to a ViteHub route that checks access on every request, such as the Console,
 * Realtime, Comments, a signed Blob link, or the Content GitHub webhook. App middleware that guards the whole app can
 * skip these requests, instead of a list of ViteHub paths. Auth access routes still apply to them, except to the
 * Console. An open route, such as `/_vitehub/browser-errors`, gets `false`. A plain Request has no route, so it gets
 * `false` too.
 */
export function checksOwnAccess(input: AuthRequestInput): boolean {
  if (routedToAccessHandler(input)) return true
  const meta = matchedRouteMeta(input)
  return meta?.vitehubOwnAccess === ownAccessRouteMeta.vitehubOwnAccess
}
