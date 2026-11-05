import { oauthProvider, oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { defineErrors } from "@vite-hub/runtime"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { verifyJwsAccessToken } from "better-auth/oauth2"
import { jwt } from "better-auth/plugins"

import { getAuthForRequest } from "./server.ts"

import type { Result } from "@vite-hub/runtime"
import type { BetterAuthPlugin } from "better-auth"

/**
 * OAuth 2.1 sign-in for an MCP server of the app, with Better Auth as the authorization server. `mcpOAuth()` adds the
 * plugins, `serveMcpOAuthDiscovery()` answers the well-known documents at the origin root, `verifyMcpRequest()` checks the
 * access token of a request, and `deleteUnusedMcpClients()` removes registrations that never signed anyone in.
 */

// Keep published codes stable. Each code has a heading on the docs page.
const mcpErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/auth/limits-and-errors",
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

type OAuthProviderOptions = Parameters<typeof oauthProvider>[0]

/** Options of {@link mcpOAuth}. */
export interface McpOAuthOptions {
  /**
   * The absolute URL of each MCP endpoint that accepts the tokens, such as `https://app.example.com/mcp`. Inside
   * `defineAuth(({ requestOrigin }) => …)`, use `${requestOrigin}/mcp`.
   */
  resource: string | readonly string[]
  /** The page where a signed-out person signs in. Better Auth sends them there with a signed query. */
  loginPage: string
  /** The page where a signed-in person allows or denies the client. Defaults to `loginPage`. */
  consentPage?: string
  /** Scopes in addition to `openid`, `profile`, `email`, and `offline_access`. */
  scopes?: readonly string[]
  /** The `iss` of the access tokens, without a trailing slash. Defaults to the Better Auth base URL, such as `https://app.example.com/api/auth`. */
  issuer?: string
  /** Limits of dynamic client registration, which anyone may call. */
  registration?: {
    /** The largest request body. Defaults to 16 KiB. */
    maxBytes?: number
  }
  /** Other `oauthProvider()` options, such as `codeExpiresIn`. They win over the defaults of `mcpOAuth()`. */
  provider?: Partial<OAuthProviderOptions>
}

const baseScopes = ["openid", "profile", "email", "offline_access"]
const registerPath = "/oauth2/register"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Bounds RFC 7591 client metadata without restricting the private-use redirect schemes of native MCP clients. */
function registrationProblem(body: unknown, maxBytes: number): string | undefined {
  if (!isRecord(body)) return "Client metadata must be an object."
  const redirects = body.redirect_uris
  if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 5) return "Register between one and five redirect URIs."
  if (JSON.stringify(body).length > maxBytes) return "Client metadata is too large."
  for (const value of Object.values(body)) {
    if (typeof value === "string" && value.length > 2048) return "Client metadata fields must be at most 2048 characters."
    if (Array.isArray(value) && (value.length > 10 || value.some(item => typeof item !== "string" || item.length > 2048))) return "Client metadata lists must have at most 10 strings of at most 2048 characters."
  }
  if (typeof body.client_name === "string" && body.client_name.length > 160) return "Client name must be at most 160 characters."
  return undefined
}

function metadataError(status: number, description: string): Response {
  return Response.json({ error: "invalid_client_metadata", error_description: description }, { headers: { "cache-control": "no-store" }, status })
}

/** Reads at most `maxBytes` of the body, so a large registration is refused before Better Auth parses it. */
async function exceedsBytes(request: Request, maxBytes: number): Promise<boolean> {
  const length = Number(request.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxBytes) return true
  const reader = request.clone().body?.getReader()
  if (!reader) return false
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return false
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) return true
    }
  }
  finally {
    void reader.cancel().catch(() => {})
  }
}

function registrationLimits(options: McpOAuthOptions): BetterAuthPlugin {
  const maxBytes = options.registration?.maxBytes ?? 16_384
  return {
    hooks: {
      before: [{
        handler: createAuthMiddleware(async (context) => {
          const problem = registrationProblem(context.body, maxBytes)
          if (problem) throw new APIError("BAD_REQUEST", { error: "invalid_client_metadata", error_description: problem })
        }),
        matcher: context => context.path === registerPath,
      }],
    },
    id: "vitehub-mcp-registration",
    async onRequest(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.replace(/\/+$/, "").endsWith(registerPath)) return
      if (await exceedsBytes(request, maxBytes)) return { response: metadataError(413, "Client metadata is too large.") }
    },
  }
}

/**
 * The Better Auth plugins that let MCP clients sign in to an MCP server of the app with OAuth 2.1: `jwt()` signs the
 * access tokens for the resource, and `oauthProvider()` registers clients, shows the login and consent pages, and issues
 * the tokens. Clients register themselves with no `application_type`, and a loopback or private-use redirect makes them
 * native clients. Registration is open, so its body and its fields are bounded. Better Auth's limiter allows 5
 * registrations per minute and IP when it is on, which it is in production.
 *
 * ```ts [server/auth.ts]
 * import { defineAuth } from "vite-hub/auth"
 * import { mcpOAuth } from "vite-hub/auth/mcp"
 *
 * export default defineAuth(({ requestOrigin }) => ({
 *   baseURL: requestOrigin,
 *   plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: "/oauth" })],
 * }))
 * ```
 */
export function mcpOAuth(options: McpOAuthOptions): BetterAuthPlugin[] {
  const resources = typeof options.resource === "string" ? [options.resource] : [...options.resource]
  return [
    // By default the plugin signs a token on every session read, which MCP sign-in never uses.
    jwt({ disableSettingJwtHeader: true, ...(options.issuer ? { jwt: { issuer: options.issuer.replace(/\/+$/, "") } } : {}) }),
    oauthProvider({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: "infer",
      clientRegistrationDefaultResources: resources,
      consentPage: options.consentPage ?? options.loginPage,
      loginPage: options.loginPage,
      resources,
      scopes: [...new Set([...baseScopes, ...options.scopes ?? []])],
      ...options.provider,
    }),
    registrationLimits(options),
  ]
}

/** What the MCP helpers read from a Better Auth instance. `getAuthForRequest()` returns one. */
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

async function stateOf(auth: McpOAuthAuth): Promise<McpOAuthState> {
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

const pathOf = (url: string) => new URL(url).pathname.replace(/\/+$/, "")

// SAFETY: `getAuthForRequest()` returns the app's Better Auth, which has every member that McpOAuthAuth names once `mcpOAuth()` is installed.
const appAuth = (request: Request) => getAuthForRequest(request) as unknown as McpOAuthAuth

/** Options of {@link serveMcpOAuthDiscovery}. */
export interface McpOAuthDiscoveryOptions {
  /** The Better Auth instance. Defaults to the app Auth for the request. */
  auth?: McpOAuthAuth
  /** `resource_name` of the protected resource metadata, which a client shows before sign-in. */
  resourceName?: string
  /** `resource_documentation`, a page about the MCP server. */
  resourceDocumentation?: string
}

/**
 * Answer the OAuth discovery documents that MCP clients read at the origin root, or return `undefined` for another path:
 *
 * - `/.well-known/oauth-protected-resource<resource path>` (RFC 9728) for each resource of `mcpOAuth()`. The bare path
 *   describes the first resource at the request origin.
 * - `/.well-known/oauth-authorization-server<issuer path>` (RFC 8414) and `/.well-known/openid-configuration<issuer path>`,
 *   which Better Auth serves only below its own base path. The bare paths answer too.
 *
 * ```ts [server/middleware/mcp-oauth.ts]
 * import { defineHandler } from "h3"
 * import { serveMcpOAuthDiscovery } from "vite-hub/auth/mcp"
 *
 * export default defineHandler(event => serveMcpOAuthDiscovery(event.req, { resourceName: "My app" }))
 * ```
 */
export async function serveMcpOAuthDiscovery(request: Request, options: McpOAuthDiscoveryOptions = {}): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const { origin, pathname } = new URL(request.url)
  const documents = ["oauth-protected-resource", "oauth-authorization-server", "openid-configuration"] as const
  const document = documents.find(name => pathname === `/.well-known/${name}` || pathname.startsWith(`/.well-known/${name}/`))
  if (!document) return undefined
  const suffix = pathname.slice(`/.well-known/${document}`.length).replace(/\/+$/, "")
  const auth = options.auth ?? appAuth(request)
  const state = await stateOf(auth)

  if (document === "oauth-protected-resource") {
    const resource = state.resources.find(entry => new URL(entry).origin === origin && (!suffix || pathOf(entry) === suffix))
    if (!resource) return undefined
    return Response.json({
      authorization_servers: [state.issuer],
      bearer_methods_supported: ["header"],
      resource,
      ...(options.resourceDocumentation ? { resource_documentation: options.resourceDocumentation } : {}),
      ...(options.resourceName ? { resource_name: options.resourceName } : {}),
      scopes_supported: state.scopes,
    }, { headers: { "cache-control": "public, max-age=15, stale-while-revalidate=15" } })
  }
  if (suffix && suffix !== pathOf(state.issuer)) return undefined
  // SAFETY: McpOAuthAuth names the two endpoints that the Better Auth helpers call.
  const metadata = document === "oauth-authorization-server" ? oauthProviderAuthServerMetadata(auth as never) : oauthProviderOpenIdConfigMetadata(auth as never)
  return metadata(request)
}

/** The person and the client of a valid MCP access token. */
export interface McpCaller {
  /** The Auth user, read again by the `sub` claim, so a deleted or banned person has no access. */
  user: { id: string, email?: string | null, name?: string | null, image?: string | null, [key: string]: unknown }
  /** The scopes that the person approved. */
  scopes: string[]
  /** The OAuth client id, from `azp` or `client_id`. */
  clientId: string | undefined
  /** The name the client registered, such as "Claude Code". */
  clientName: string | undefined
}

/** Options of {@link verifyMcpRequest}. */
export interface VerifyMcpRequestOptions {
  /** The Better Auth instance. Defaults to the app Auth for the request. */
  auth?: McpOAuthAuth
  /** The resource that the token must name as its audience. Defaults to the `mcpOAuth()` resource at the path of the request. */
  resource?: string
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
 * session, that session must still exist and be unexpired. Returns `AUTH_MCP_TOKEN_MISSING` without a bearer token and
 * `AUTH_MCP_TOKEN_INVALID` for a token that fails a check. Throws `AUTH_MCP_OAUTH_MISSING` when the Auth has no `mcpOAuth()`.
 */
export async function verifyMcpRequest(request: Request, options: VerifyMcpRequestOptions = {}): Promise<Result<McpCaller, "AUTH_MCP_TOKEN_INVALID" | "AUTH_MCP_TOKEN_MISSING">> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!token) return [mcpErrors.AUTH_MCP_TOKEN_MISSING(), undefined]
  const auth = options.auth ?? appAuth(request)
  const state = await stateOf(auth)
  const url = new URL(request.url)
  const resource = options.resource ?? state.resources.find(entry => new URL(entry).origin === url.origin && pathOf(entry) === url.pathname.replace(/\/+$/, ""))
  if (!resource) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: `${url.pathname} is not a resource of \`mcpOAuth()\`.` }), undefined]

  const jwks: unknown = await auth.api.getJwks()
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys.filter(isRecord) : []
  const algorithms = [...new Set(keys.flatMap(key => typeof key.alg === "string" ? [key.alg] : []))]
  if (!algorithms.length) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the Auth has no signing keys." }), undefined]
  let payload: Record<string, unknown>
  try {
    payload = await verifyJwsAccessToken(token, {
      // SAFETY: The value has a `keys` array of JSON Web Keys, which is a JSON Web Key Set.
      jwksFetch: async () => jwks as { keys: Array<Record<string, string>> },
      verifyOptions: { algorithms, audience: resource, clockTolerance: clockToleranceSeconds, issuer: state.issuer, requiredClaims: ["exp", "sub"] },
    })
  }
  catch (error) {
    return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ cause: error, reason: error instanceof Error ? error.message : "the signature or a claim does not match." }), undefined]
  }

  const context = await auth.$context
  const user = await context.internalAdapter.findUserById(String(payload.sub))
  if (!isRecord(user) || typeof user.id !== "string" || banned(user)) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the user does not exist or is banned." }), undefined]
  const clientId = typeof payload.azp === "string" ? payload.azp : typeof payload.client_id === "string" ? payload.client_id : undefined
  const client = clientId ? await context.adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] }) : undefined
  if (!isRecord(client) || client.disabled) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the OAuth client does not exist or is disabled." }), undefined]
  if (typeof payload.sid === "string") {
    const session = await context.adapter.findOne({ model: "session", where: [{ field: "id", value: payload.sid }] })
    if (!isRecord(session) || !(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= Date.now()) return [mcpErrors.AUTH_MCP_TOKEN_INVALID({ reason: "the session does not exist or has expired." }), undefined]
  }
  const scope = payload.scope
  return [undefined, {
    clientId,
    clientName: typeof client.name === "string" && client.name ? client.name : undefined,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : Array.isArray(scope) ? scope.filter((entry): entry is string => typeof entry === "string") : [],
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
