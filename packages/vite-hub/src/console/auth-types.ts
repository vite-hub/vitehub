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

/** The request that `console.authorize` checks with `auth: "token"`. It sent the Console token, so it has no user. */
export interface ConsoleTokenAuthorizeContext {
  request: Request
  user?: undefined
  via: "token"
}

/**
 * The check for an Agent that calls Console operations as tools. No browser request and no token reach it: the request has
 * no headers, and `user` is the person the Agent acts for, when there is one.
 */
export interface ConsoleAgentAuthorizeContext {
  request: Request
  user?: ConsoleUser
  via: "agent"
}

/**
 * The request that `console.authorize` checks. `via` is `"token"` when the caller sent a valid Console token, and
 * `"agent"` when an Agent calls Console operations as tools.
 */
export type ConsoleAuthorizeContext = ConsoleSessionAuthorizeContext | ConsoleTokenAuthorizeContext | ConsoleAgentAuthorizeContext

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
