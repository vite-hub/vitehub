import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import type { AccessAuthorizationContext } from "@vite-hub/runtime"

/** The signed-in user that the Console gives `console.authorize`. */
export type ConsoleUser = AccessAuthorizationContext["user"]

/** The request that `console.authorize` checks with `console: { auth: false }` in development. It has no signature and no user. */
export interface ConsoleOpenAuthorizeContext {
  request: Request
  user?: undefined
  via?: undefined
}

/**
 * The request that `console.authorize` checks when the ViteHub Console signed it. The Console signs
 * the person who called, so the app can check who edits. The holder of the key asserts the person: trust it as much as
 * the key.
 */
export interface ConsoleSignedConsoleAuthorizeContext {
  request: Request
  /** The person signed in to the Console. */
  user: ConsoleUser & ConsoleCallerUser
  /** The Console team that linked the app, and the role of `user` in it, such as `owner`, `admin`, or `member`. */
  team?: { id: string, role?: string }
  /** The `<NAME>` of the `VITEHUB_CONSOLE_KEY_<NAME>` variable whose key verified the signature. */
  key: string
  /** `"mcp"` when the ViteHub MCP of the Console calls for `user`, such as from Claude Code. Not set for the Console page. */
  surface?: "mcp"
  via: "console"
}

/** The request that `console.authorize` checks when the CLI signed it. The CLI has no user. */
export interface ConsoleSignedCliAuthorizeContext {
  request: Request
  user?: undefined
  /** The `<NAME>` of the `VITEHUB_CONSOLE_KEY_<NAME>` variable whose key verified the signature. */
  key: string
  via: "cli"
}

/**
 * The check for an Agent that calls Console operations as tools. No browser request and no signature reach it: the request has
 * no headers, and `user` is the person the Agent acts for, when there is one.
 */
export interface ConsoleAgentAuthorizeContext {
  request: Request
  user?: ConsoleUser
  via: "agent"
}

/**
 * The check of the **Console** link in the page tools pill. It is not a Console call: the request is the page tools
 * session request of a page of the app, and `user` is the ViteHub Auth user signed in to the app, when there is one.
 * `true` or `{ sections }` with at least one section shows the link. The link gives no access: the Console checks the
 * person and the team when it opens.
 */
export interface ConsolePageAuthorizeContext {
  request: Request
  /** The ViteHub Auth user of the page. Not set when the app has no Auth or nobody signed in. */
  user?: ConsoleUser
  via: "page"
}

/**
 * The request that `console.authorize` checks. `via` is `"console"` or `"cli"`: who signed the request. `via` is
 * `"agent"` when an Agent calls Console operations as tools, `"page"` when the page tools pill asks whether to show the
 * Console link, and not set for an open Console in development.
 */
export type ConsoleAuthorizeContext = ConsoleOpenAuthorizeContext | ConsoleSignedConsoleAuthorizeContext | ConsoleSignedCliAuthorizeContext | ConsoleAgentAuthorizeContext | ConsolePageAuthorizeContext

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
