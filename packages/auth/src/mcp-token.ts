import { defineErrors } from "@vite-hub/runtime"
import { verifyJwsAccessToken } from "better-auth/oauth2"

import { findAccessPolicyPlugin } from "./access-policy.ts"
import { authForRequest } from "./auth-instance.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { Result } from "@vite-hub/runtime"

// The token check and cleanup of `vite-hub/auth/mcp`, apart from `mcpOAuth()`, so `requireCaller()` loads them without
// `@better-auth/oauth-provider`, an optional peer dependency.

// Keep published codes stable. Each code has a heading on the docs page.
const mcpErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/auth/diagnostics",
  codes: {
    // Config errors. They throw because the Auth must change.
    AUTH_MCP_OAUTH_MISSING: {
      why: "The Auth has no MCP OAuth: its plugins do not include `oauthProvider()` with `resources`.",
      fix: "Add `...mcpOAuth({ resource, loginPage })` from `vite-hub/auth/mcp` to the `plugins` of `defineAuth()`.",
    },

    // Runtime errors. `verifyMcpRequest()` and `deleteUnusedMcpClients()` return them as `[error, undefined]`.
    AUTH_MCP_TOKEN_MISSING: {
      why: "The request has no `Authorization: Bearer` access token.",
      fix: "Answer `401` with `WWW-Authenticate: Bearer resource_metadata=\"…\"`, so the MCP client starts the OAuth flow.",
    },
    AUTH_MCP_TOKEN_INVALID: {
      why: ({ reason }: { reason: string }) => `The access token is not valid: ${reason}`,
      fix: "Answer `401` with `error=\"invalid_token\"`, so the MCP client signs in again.",
    },
    AUTH_MCP_CLEANUP_FAILED: {
      why: "The Auth database could not list or delete OAuth clients.",
      fix: "Read `error.cause` for the database error, then run the cleanup again.",
    },
  },
})

export type McpOAuthErrorCode = "AUTH_MCP_CLEANUP_FAILED" | "AUTH_MCP_OAUTH_MISSING" | "AUTH_MCP_TOKEN_INVALID" | "AUTH_MCP_TOKEN_MISSING"

export const baseScopes: string[] = ["openid", "profile", "email", "offline_access"]

/** What the MCP helpers read from a Better Auth instance. `useAuth()` returns one. */
export interface McpOAuthAuth {
  $context: Promise<{
    baseURL: string
    options: { plugins?: ReadonlyArray<{ id?: string, options?: unknown }> }
    internalAdapter: { findUserById: (id: string) => Promise<unknown> }
    adapter: {
      findOne: (input: { model: string, where: Array<{ field: string, value: string }> }) => Promise<unknown>
      findMany: (input: { model: string, where: Array<{ field: string, operator?: "lt", value: Date }>, limit?: number }) => Promise<unknown[]>
      count: (input: { model: string, where: Array<{ field: string, value: string }> }) => Promise<number>
      deleteMany: (input: { model: string, where: Array<{ field: string, value: string }> }) => Promise<number>
    }
  }>
  api: {
    getJwks: (...args: never[]) => Promise<unknown>
    getOAuthServerConfig: (...args: never[]) => unknown
    getOpenIdConfig: (...args: never[]) => unknown
  }
}

interface McpOAuthState {
  issuer: string
  resources: string[]
  scopes: string[]
}

export async function stateOf(auth: McpOAuthAuth): Promise<McpOAuthState> {
  const context = await auth.$context
  const plugins = context.options.plugins ?? []
  const provider = plugins.find(plugin => plugin.id === "oauth-provider")?.options
  const resources = isRecord(provider) && Array.isArray(provider.resources)
    ? provider.resources.flatMap(entry => typeof entry === "string" ? [entry] : isRecord(entry) && typeof entry.identifier === "string" ? [entry.identifier] : [])
    : []
  if (!resources.length) throw mcpErrors.AUTH_MCP_OAUTH_MISSING()
  const jwtOptions = plugins.find(plugin => plugin.id === "jwt")?.options
  const issuer = isRecord(jwtOptions) && isRecord(jwtOptions.jwt) && typeof jwtOptions.jwt.issuer === "string" ? jwtOptions.jwt.issuer : context.baseURL
  const scopes = isRecord(provider) && Array.isArray(provider.scopes) ? provider.scopes.filter((scope): scope is string => typeof scope === "string") : baseScopes
  return { issuer: issuer.replace(/\/+$/, ""), resources, scopes }
}

export const pathOf = (url: string): string => new URL(url).pathname.replace(/\/+$/, "")

export const appAuth = (request: Pick<Request, "headers" | "url">): McpOAuthAuth => mcpOAuthAuth(authForRequest(request))

/** The app's Better Auth, as the MCP helpers read it. */
export function mcpOAuthAuth(auth: object): McpOAuthAuth {
  // SAFETY: The app's Better Auth has every member that McpOAuthAuth names once `mcpOAuth()` is installed.
  return auth as McpOAuthAuth
}

/** The person and the client of a valid MCP access token. */
export interface McpCaller {
  /** The Auth user, read again by the `sub` claim, so a deleted or banned person has no access. */
  user: { id: string, email?: string | null, name?: string | null, image?: string | null, [key: string]: unknown }
  /** The scopes that the person approved. */
  scopes: string[]
  /** The OAuth client id, from `azp` or `client_id`. */
  clientId: string
  /** The name the client registered, such as "Claude Code". */
  clientName: string | undefined
}

/** Options of {@link verifyMcpRequest}. */
export interface VerifyMcpRequestOptions {
  /** The Better Auth instance. Defaults to the app Auth for the request. */
  auth?: McpOAuthAuth
  /**
   * The resource that the token must name as its audience, or a list of which it must name one. Defaults to the
   * `mcpOAuth()` resource at the path of the request.
   */
  resource?: string | readonly string[]
}

const clockToleranceSeconds = 30

function banned(user: Record<string, unknown>): boolean {
  if (user.banned !== true) return false
  const expires = user.banExpires
  const until = expires instanceof Date ? expires.getTime() : typeof expires === "string" || typeof expires === "number" ? new Date(expires).getTime() : Number.NaN
  return Number.isNaN(until) || until > Date.now()
}

/**
 * Check the OAuth access token of an MCP request. The signing keys come from the Auth in-process, with no request to the
 * authorization server. The signature algorithm is pinned to the keys, and the issuer, the audience (the resource), and
 * the expiry are checked with 30 seconds of tolerance. The client must still be enabled and, when the token names a
 * session, that session must still exist and be unexpired, unless the person granted `offline_access`: that grant is for
 * use while they are signed out, and Better Auth's refresh grant copies the session of the first sign-in into every
 * access token it mints. Sender-constrained tokens, including DPoP-bound tokens, are rejected even when presented as
 * bearer tokens. It reads only the URL and the headers, so pass the Request of a Fetchable route, H3's `event.req`, or
 * any value with `url` and `headers`, and the body stays for the MCP handler. Returns `AUTH_MCP_TOKEN_MISSING` without a
 * bearer token and `AUTH_MCP_TOKEN_INVALID` for a token that fails a check. Throws `AUTH_MCP_OAUTH_MISSING` when the Auth has no `mcpOAuth()`.
 */
export async function verifyMcpRequest(request: Pick<Request, "headers" | "url">, options: VerifyMcpRequestOptions = {}): Promise<Result<McpCaller, "AUTH_MCP_TOKEN_INVALID" | "AUTH_MCP_TOKEN_MISSING">> {
  const token = bearerToken(request.headers)
  if (!token) return [mcpErrors.AUTH_MCP_TOKEN_MISSING(), undefined]
  const auth = options.auth ?? appAuth(request)
  const state = await stateOf(auth)
  const url = new URL(request.url)
  const resource = options.resource ?? state.resources.find(entry => new URL(entry).origin === url.origin && pathOf(entry) === url.pathname.replace(/\/+$/, ""))
  return await verifyToken(token, auth, state, resource, url.pathname)
}

/** The token of an `Authorization: Bearer` header. */
const bearerToken = (headers: Pick<Headers, "get">): string | undefined => /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1]

/**
 * Check an MCP access token for any `mcpOAuth()` resource at the origin of the request, for `requireCaller()`, which
 * accepts the token on every route of the app.
 */
export async function verifyAppAccessToken(token: string, origin: string, pathname: string, instance: object): Promise<Result<McpCaller, "AUTH_MCP_TOKEN_INVALID">> {
  const auth = mcpOAuthAuth(instance)
  const state = await stateOf(auth)
  return await verifyToken(token, auth, state, state.resources.filter(entry => new URL(entry).origin === origin), pathname)
}

async function verifyToken(token: string, auth: McpOAuthAuth, state: McpOAuthState, resource: string | readonly string[] | undefined, path: string): Promise<Result<McpCaller, "AUTH_MCP_TOKEN_INVALID">> {
  if (!resource?.length) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: `${path} is not a resource of \`mcpOAuth()\`.` }), undefined]
  const jwks: unknown = await auth.api.getJwks()
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys.filter(isRecord) : []
  const algorithms = [...new Set(keys.flatMap(key => typeof key.alg === "string" ? [key.alg] : []))]
  if (!algorithms.length) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the Auth has no signing keys." }), undefined]
  let payload: Record<string, unknown>
  try {
    payload = await verifyJwsAccessToken(token, {
      // SAFETY: The value has a `keys` array of JSON Web Keys, which is a JSON Web Key Set.
      jwksFetch: async () => jwks as { keys: Array<Record<string, string>> },
      verifyOptions: { algorithms, audience: typeof resource === "string" ? resource : [...resource], clockTolerance: clockToleranceSeconds, issuer: state.issuer, requiredClaims: ["exp", "sub"] },
    })
  }
  catch (error) {
    return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ cause: error, reason: error instanceof Error ? error.message : "the signature or a claim does not match." }), undefined]
  }
  if (payload.cnf !== undefined) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "sender-constrained access tokens are not supported; use a bearer token." }), undefined]

  const context = await auth.$context
  const user = await context.internalAdapter.findUserById(String(payload.sub))
  if (!isRecord(user) || typeof user.id !== "string" || banned(user)) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the user does not exist or is banned." }), undefined]
  const policy = findAccessPolicyPlugin(context.options.plugins)
  // SAFETY: `findUserById` returns the Auth user record, and its `id` is checked above.
  if (policy && !await policy.allows(user as Parameters<typeof policy.allows>[0], `mcp:${user.id}`)) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "`access.policy` or `VITEHUB_MEMBERS` does not allow the user." }), undefined]
  const clientId = typeof payload.azp === "string" ? payload.azp : typeof payload.client_id === "string" ? payload.client_id : undefined
  const client = clientId ? await context.adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] }) : undefined
  if (!clientId || !isRecord(client) || client.disabled) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the OAuth client does not exist or is disabled." }), undefined]
  const scope = payload.scope
  const scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : Array.isArray(scope) ? scope.filter((entry): entry is string => typeof entry === "string") : []
  if (typeof payload.sid === "string" && !scopes.includes("offline_access")) {
    const session = await context.adapter.findOne({ model: "session", where: [{ field: "id", value: payload.sid }] })
    if (!isRecord(session) || !(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= Date.now()) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the session does not exist or has expired." }), undefined]
  }
  return [undefined, {
    clientId,
    clientName: typeof client.name === "string" && client.name ? client.name : undefined,
    scopes,
    // SAFETY: `findUserById` returns the Auth user record, and its `id` is checked above.
    user: user as McpCaller["user"],
  }]
}

/** Options of {@link deleteUnusedMcpClients}. */
export interface DeleteUnusedMcpClientsOptions {
  /** The Better Auth instance. Defaults to the app Auth. */
  auth?: McpOAuthAuth
  /** Age in milliseconds after which a client that never got a consent or a token is deleted. Defaults to 24 hours. */
  olderThan?: number
  /** Clients checked in one call. Defaults to 500. */
  limit?: number
}

/**
 * Delete OAuth clients that registered more than `olderThan` ago and never completed a sign-in: no consent, no access
 * token, and no refresh token. Open registration lets anyone add clients, so run it from a schedule. Returns the number
 * of deleted clients.
 */
export async function deleteUnusedMcpClients(options: DeleteUnusedMcpClientsOptions = {}): Promise<Result<{ deleted: number }, "AUTH_MCP_CLEANUP_FAILED">> {
  const auth = options.auth ?? appAuth(new Request("http://localhost/"))
  try {
    const { adapter } = await auth.$context
    const cutoff = new Date(Date.now() - (options.olderThan ?? 24 * 60 * 60 * 1000))
    const clients = await adapter.findMany({ limit: options.limit ?? 500, model: "oauthClient", where: [{ field: "createdAt", operator: "lt", value: cutoff }] })
    let deleted = 0
    for (const client of clients) {
      if (!isRecord(client) || typeof client.clientId !== "string") continue
      const where = [{ field: "clientId", value: client.clientId }]
      const uses = await Promise.all(["oauthConsent", "oauthAccessToken", "oauthRefreshToken"].map(model => adapter.count({ model, where })))
      if (uses.some(count => count > 0)) continue
      await adapter.deleteMany({ model: "oauthClientResource", where })
      deleted += await adapter.deleteMany({ model: "oauthClient", where })
    }
    return [undefined, { deleted }]
  }
  catch (error) {
    return [mcpErrors.AUTH_MCP_CLEANUP_FAILED({ cause: error }), undefined]
  }
}
