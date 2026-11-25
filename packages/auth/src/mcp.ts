import { oauthProvider, oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { jwt } from "better-auth/plugins"

import { isRecord } from "@vite-hub/internal/object"
import { mcpRegistrationPluginId } from "./mcp-config.ts"
import { appAuth, baseScopes, pathOf, stateOf } from "./mcp-token.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { McpOAuthAuth } from "./mcp-token.ts"

export { deleteUnusedMcpClients, mcpTokenInvalidReasons, verifyMcpRequest } from "./mcp-token.ts"
export type { DeleteUnusedMcpClientsOptions, McpCaller, McpOAuthAuth, McpOAuthErrorCode, McpTokenInvalidData, McpTokenInvalidReason, VerifyMcpRequestOptions } from "./mcp-token.ts"

/**
 * OAuth 2.1 sign-in for an MCP server of the app, with Better Auth as the authorization server. `mcpOAuth()` adds the
 * plugins, `serveMcpOAuthDiscovery()` answers the well-known documents at the origin root, `verifyMcpRequest()` checks the
 * access token of a request, and `deleteUnusedMcpClients()` removes registrations that never signed anyone in.
 */

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

/**
 * The plugins of {@link mcpOAuth}, with their own types, so the typed Auth of a Definition that spreads them has the
 * JWT and OAuth provider endpoints, such as `api.getJwks`.
 */
export type McpOAuthPlugins = [ReturnType<typeof jwt>, ReturnType<typeof oauthProvider>, BetterAuthPlugin]

const registerPath = "/oauth2/register"

/** Bounds RFC 7591 client metadata without restricting the private-use redirect schemes of native MCP clients. */
function registrationProblem(body: unknown, maxBytes: number): string | undefined {
  if (!isRecord(body)) return "Client metadata must be an object."
  const redirects = body.redirect_uris
  if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 5) return "Register between one and five redirect URIs."
  if (body.dpop_bound_access_tokens === true) return "MCP OAuth supports bearer tokens, not DPoP-bound access tokens."
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
    id: mcpRegistrationPluginId,
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
 * registrations per minute for each client IP. `defineAuth()` turns it on outside a development server, on every host.
 * DPoP-bound client registration is refused; these helpers support bearer tokens.
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
export function mcpOAuth(options: McpOAuthOptions): McpOAuthPlugins {
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

/** Options of {@link serveMcpOAuthDiscovery}. */
export interface McpOAuthDiscoveryOptions {
  /** The Better Auth instance. Defaults to the app Auth for the request. */
  auth?: McpOAuthAuth
  /** `resource_name` of the protected resource metadata, which a client shows before sign-in. */
  resourceName?: string
  /** `resource_documentation`, a page about the MCP server. */
  resourceDocumentation?: string
}

// The documents are public. MCP clients that run in a browser, such as the MCP Inspector, read them from another origin.
const discoveryCors = {
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "86400",
}

const discoveryDocuments = ["oauth-protected-resource", "oauth-authorization-server", "openid-configuration"] as const

/**
 * Answer the OAuth discovery documents that MCP clients read at the origin root, or return `undefined` for another path:
 *
 * - `/.well-known/oauth-protected-resource<resource path>` (RFC 9728) for each resource of `mcpOAuth()`. The bare path
 *   describes the first resource at the request origin.
 * - `/.well-known/oauth-authorization-server<issuer path>` (RFC 8414) and `/.well-known/openid-configuration<issuer path>`,
 *   which Better Auth serves only below its own base path. The bare paths answer too.
 *
 * Every answer allows any origin with CORS, and an `OPTIONS` preflight gets `204`, so MCP clients in a browser read them.
 *
 * ```ts [server/middleware/mcp-oauth.ts]
 * import { defineHandler } from "h3"
 * import { serveMcpOAuthDiscovery } from "vite-hub/auth/mcp"
 *
 * export default defineHandler(event => serveMcpOAuthDiscovery(event.req, { resourceName: "My app" }))
 * ```
 */
export async function serveMcpOAuthDiscovery(request: Request, options: McpOAuthDiscoveryOptions = {}): Promise<Response | undefined> {
  const { pathname } = new URL(request.url)
  const document = discoveryDocuments.find(name => pathname === `/.well-known/${name}` || pathname.startsWith(`/.well-known/${name}/`))
  if (!document) return undefined
  if (request.method === "OPTIONS") return new Response(null, { headers: discoveryCors, status: 204 })
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const response = await discoveryDocument(request, document, options)
  if (!response) return undefined
  // A copy, since the headers of a Response that another library made can be immutable.
  const answer = new Response(response.body, response)
  for (const [name, value] of Object.entries(discoveryCors)) answer.headers.set(name, value)
  return answer
}

async function discoveryDocument(request: Request, document: typeof discoveryDocuments[number], options: McpOAuthDiscoveryOptions): Promise<Response | undefined> {
  const { origin, pathname } = new URL(request.url)
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
