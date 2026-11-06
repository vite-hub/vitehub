import type { AccessAuthorizationContext } from "@vite-hub/runtime"

/** The signed-in user that the Console gives `console.authorize`. */
export type ConsoleUser = AccessAuthorizationContext["user"]

/** The request that `console.authorize` checks, from a session, an open Console, or Cloudflare Access. */
export interface ConsoleSessionAuthorizeContext {
  request: Request
  /** The signed-in user with `auth: "app"` or a session-based Console Auth. Not set with `auth: false` or Cloudflare Access. */
  user?: ConsoleUser
  via?: undefined
}

/** The request that `console.authorize` checks with `auth: "token"`. It sent `VITEHUB_CONSOLE_TOKEN`, so it has no user. */
export interface ConsoleTokenAuthorizeContext {
  request: Request
  user?: undefined
  via: "token"
}

/** The request that `console.authorize` checks. `via` is `"token"` when the caller sent the Console token. */
export type ConsoleAuthorizeContext = ConsoleSessionAuthorizeContext | ConsoleTokenAuthorizeContext

/**
 * What `console.authorize` returns for one request.
 * - `true` allows every Console section.
 * - `{ sections }` allows only these section ids, for example `["content"]`. `"content:read"` allows only the operations of
 *   that section that read. `"blob:media"` allows the Blob operations on the `media` store only. An empty list is `403`.
 * - `false` is `403`. A `Response` is returned as-is.
 */
export type ConsoleAuthorizeResult = boolean | Response | { sections: readonly string[] }

/** Decides whether one Console request may continue, and which Console sections it may use. */
export type ConsoleAuthorize = (context: ConsoleAuthorizeContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>
