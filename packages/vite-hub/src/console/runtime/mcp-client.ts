/**
 * The MCP client section of the Console: an MCP client that runs on the server. It connects to MCP servers over Streamable
 * HTTP as the person who signed in to the Console, and keeps each grant, token, and MCP session on the server. The
 * browser gets only these descriptions.
 */

/** Path of the OAuth callback page under the Console mount. Authorization servers redirect the browser here. */
export const consoleMcpCallbackPath = "/_vitehub/mcp-client/callback"

/**
 * How a connection proves who it is:
 * - `oauth`: the MCP authorization flow (RFC 9728 discovery, client registration, PKCE).
 * - `bearer`: a token that the person pasted, such as a personal API key.
 * - `none`: the server does not ask for credentials.
 * - `console`: the Console session of each request. Only ViteHub MCP, the MCP server of the Console, gets it.
 */
export type ConsoleMcpAuth = "bearer" | "console" | "none" | "oauth"

/**
 * - `connected`: the last request worked.
 * - `authorizing`: OAuth sign-in started and the browser has not come back yet.
 * - `signed-out`: the server rejects the grant. Sign in again.
 * - `failed`: the server could not be reached, or it failed the MCP handshake.
 */
export type ConsoleMcpStatus = "authorizing" | "connected" | "failed" | "signed-out"

/** Who the server knows the connection as, from the OpenID Connect ID token or the access token. */
export interface ConsoleMcpIdentity {
  email?: string
  name?: string
  picture?: string
  subject?: string
}

export interface ConsoleMcpServerInfo {
  capabilities: { completions: boolean, logging: boolean, prompts: boolean, resources: boolean, tools: boolean }
  description?: string
  icon?: string
  instructions?: string
  name: string
  protocolVersion?: string
  title?: string
  version?: string
  websiteUrl?: string
}

/** The grant of a connection, without the token. */
export interface ConsoleMcpGrant {
  /** When the access token expires, as an ISO date. */
  expiresAt?: string
  /** The last four characters of a pasted token, so two tokens can be told apart. */
  hint?: string
  /** The OAuth authorization server. */
  issuer?: string
  refreshable: boolean
  scopes: string[]
}

export interface ConsoleMcpConnection {
  auth: ConsoleMcpAuth
  createdAt: string
  /** Why the last request failed. */
  error?: string
  grant?: ConsoleMcpGrant
  id: string
  identity?: ConsoleMcpIdentity
  label: string
  /** The server is on the origin of the Console, such as the app's own `/mcp`. */
  sameOrigin: boolean
  server?: ConsoleMcpServerInfo
  /** The end of the MCP session id. Stateless servers have no session. */
  session?: string
  status: ConsoleMcpStatus
  /** The MCP endpoint. */
  url: string
  usedAt?: string
}

/** An MCP server on the Console's origin that the app announces in its RFC 9728 metadata. */
export interface ConsoleMcpCandidate {
  /** `console`: ViteHub MCP, which the Console connects to with the session of the person. */
  auth?: "console"
  /** The OAuth authorization server that the metadata names. */
  authorizationServer?: string
  label: string
  url: string
}

export interface ConsoleMcpOverview {
  connections: ConsoleMcpConnection[]
  servers: ConsoleMcpCandidate[]
  /**
   * The Console uses the app's own sign-in. Signing in as someone else at an authorization server on this origin would
   * also sign the Console in as them.
   */
  sharedSession: boolean
}

export interface ConsoleMcpConnectResult {
  /** Open this URL to sign in. Absent when the connection did not need OAuth. */
  authorizationUrl?: string
  connection: ConsoleMcpConnection
}

/** One page of a list that an MCP server returns. The items are as the server sent them. */
export interface ConsoleMcpPage {
  items: Record<string, unknown>[]
  nextCursor?: string
}

export type ConsoleMcpListKind = "prompts" | "resource-templates" | "resources" | "tools"

/** The answer of one request: the result, or the JSON-RPC error that the server returned instead. */
export interface ConsoleMcpOutcome {
  durationMs: number
  error?: { code: number, data?: unknown, message: string }
  result?: Record<string, unknown>
}
