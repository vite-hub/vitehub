// The root entry and the generated access middleware import this module. Keep it free of Better Auth imports.
import { ownAccessHandlerMeta } from "@vite-hub/internal/nitro-kit"

import type { AuthRequestInput } from "./types.ts"

/**
 * The Nitro route `meta` of a handler that checks its own access, such as the ViteHub Console route. The access routes
 * leave a request to the handler that Nitro routed it to when that handler has this meta, whatever its path and method.
 * The exception follows the dispatch, so an app route file on the same path keeps the access routes.
 */
export const authAccessHandlerMeta: Readonly<{ vitehubAuthAccess: "handler" }> = ownAccessHandlerMeta

/**
 * Whether Nitro routed the request event to a ViteHub route that checks its own access, such as Realtime, Comments,
 * Sync, a signed Blob link, or a signed webhook. Auth access routes skip these requests. App middleware that guards the
 * whole app can skip them too, instead of a list of ViteHub paths. An open route, such as `/_vitehub/browser-errors`,
 * gets `false`. A plain Request has no route, so it gets `false` too.
 */
export function checksOwnAccess(input: AuthRequestInput): boolean {
  if (!("context" in input) || !(input.context instanceof Object)) return false
  const route: unknown = Reflect.get(input.context, "matchedRoute")
  const meta: unknown = route instanceof Object ? Reflect.get(route, "meta") : undefined
  return meta instanceof Object && Reflect.get(meta, "vitehubAuthAccess") === authAccessHandlerMeta.vitehubAuthAccess
}
