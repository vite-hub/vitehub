import { oauthProvider } from "@better-auth/oauth-provider"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { jwt } from "better-auth/plugins"

import { consoleAuthPath } from "./auth-path.ts"
import { consoleMcpScopes } from "./runtime/server/bearer.ts"
import { listedConsoleOrigin } from "./runtime/server/cors.ts"

import type { CimdOptions } from "@better-auth/cimd"
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider"
import type { BetterAuthPlugin } from "better-auth"
import type { GenericEndpointContext } from "better-auth"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A redirect that only a program on this machine can receive: a loopback address or a private-use scheme. */
function isNativeRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return false
    if (url.protocol !== "http:") return true
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  }
  catch {
    return false
  }
}

/**
 * MCP clients register themselves with a loopback redirect and no `application_type`. This version of the OAuth provider
 * then treats them as web clients and refuses the redirect, so the registration says "native" for them.
 */
export function consoleMcpNativeClients(): BetterAuthPlugin {
  return {
    hooks: {
      before: [{
        handler: createAuthMiddleware(async (context) => {
          const body: unknown = context.body
          if (!isRecord(body) || body.application_type !== undefined) return
          const redirects = body.redirect_uris
          if (Array.isArray(redirects) && redirects.length && redirects.every(isNativeRedirect)) return { context: { body: { ...body, application_type: "native" } } }
        }),
        matcher: context => context.path === "/oauth2/register",
      }],
    },
    id: "vitehub-console-native-clients",
  }
}

/** How long a Console access token is valid: 15 minutes. A signed token stays valid until it expires, so it is short. */
export const consoleAccessTokenSeconds: number = 15 * 60
/** How long a Console refresh token is valid: 7 days. Each refresh rotates it. Revoking it stops the next refresh. */
export const consoleRefreshTokenSeconds: number = 7 * 24 * 60 * 60

/** The Console resource next to an MCP resource: `https://app.example.com/_vitehub/mcp` gives `https://app.example.com/_vitehub`. */
export function consoleResourceOf(mcpResource: string): string {
  const url = new URL(mcpResource)
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}`
}

/**
 * The `resources` entry of the Console resource: short access tokens and a shorter refresh token lifetime than
 * Better Auth's 30-day default. The MCP resource keeps the plugin defaults.
 */
function consoleResourceEntry(resource: string): { accessTokenTtl: number, identifier: string, refreshTokenTtl: number } {
  return { accessTokenTtl: consoleAccessTokenSeconds, identifier: resource, refreshTokenTtl: consoleRefreshTokenSeconds }
}

/**
 * The default transport for client ID Metadata Documents: the platform `fetch`, with redirects returned and never
 * followed. It runs only after the allow list accepted the URL, so it reaches only origins in `console.origins`, which
 * the app trusts. It does not pin the DNS answer. On Node.js, pass `fetchClientMetadataResource` from
 * `@better-auth/cimd/node` as `clientMetadataFetch` to also refuse hosts that resolve to private addresses.
 */
const platformClientMetadataFetch: ClientMetadataResourceFetch = (input, init) => fetch(input, { ...init, redirect: "manual" })

function stringParameter(value: unknown): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : undefined
}

/** Whether a `client_id` is a client ID Metadata Document URL, the form that Better Auth's `cimd()` resolves. */
function isClientMetadataDocumentUrl(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === "https:"
  }
  catch {
    return false
  }
}

/**
 * Better Auth's `cimd()` plugin, loaded when the Auth starts, so the other Console Auth exports load without
 * `@better-auth/cimd`. Without the package, the Auth starts with a warning and accepts no Console client; MCP sign-in
 * keeps working. One plugin per call keeps one metadata cache.
 */
function lazyCimd(options: CimdOptions): BetterAuthPlugin {
  let plugin: Promise<BetterAuthPlugin | undefined> | undefined
  return {
    id: "cimd",
    init: async (context) => {
      plugin ??= import("@better-auth/cimd").then(module => module.cimd(options), (error: unknown) => {
        globalThis.console?.warn(`[vitehub] consoleMcpOAuth() could not load @better-auth/cimd, so no Console on console.origins can sign in with OAuth. Install @better-auth/cimd at the version of better-auth. MCP sign-in keeps working. ${error instanceof Error ? error.message : ""}`.trim())
        return undefined
      })
      await (await plugin)?.init?.(context)
    },
  }
}

function invalidConsoleClient(description: string): APIError {
  return new APIError("BAD_REQUEST", { error: "invalid_client", error_description: description })
}

/** The origin of a client ID Metadata Document URL that `console.origins` lists, or an error. */
function listedClientOrigin(clientId: string): string {
  const origin = new URL(clientId).origin
  if (!listedConsoleOrigin(origin)) throw invalidConsoleClient(`The client ${clientId} is not on an origin in console.origins of this app. Add ${origin} to console.origins, then build and deploy again.`)
  return origin
}

const corsPaths = ["/oauth2/token", "/oauth2/revoke"]

/** Link a client to the Console resource, so it may ask for Console tokens. Clients of other sources stay unlinked. */
async function linkConsoleResource(context: GenericEndpointContext, clientId: string, resource: string): Promise<void> {
  const provider: unknown = context.context.getPlugin("oauth-provider")?.options
  const schema = isRecord(provider) && isRecord(provider.schema) && isRecord(provider.schema.oauthClientResource) ? provider.schema.oauthClientResource : {}
  const model = typeof schema.modelName === "string" ? schema.modelName : "oauthClientResource"
  const where = [{ field: "clientId", value: clientId }, { field: "resourceId", value: resource }]
  if (await context.context.adapter.findOne({ model, where })) return
  await context.context.adapter.create({ data: { clientId, createdAt: new Date(), resourceId: resource }, model })
}

/** Options of {@link consoleOAuthClients}. */
export interface ConsoleOAuthClientsOptions {
  /** The Console resource, `<origin><base>/_vitehub`. It must be in `oauthProvider({ resources })`. */
  resource: string
  /** The transport for client ID Metadata Documents. Defaults to the platform `fetch`, without redirects. */
  clientMetadataFetch?: ClientMetadataResourceFetch
}

/**
 * The Better Auth plugins that let a Console on another origin sign in with OAuth: authorization code with PKCE (S256)
 * and no client secret. The Console identifies itself with a client ID Metadata Document (CIMD), an `https://` URL such
 * as `https://console.vitehub.dev/oauth-client.json`, through Better Auth's `cimd()` plugin.
 *
 * `console.origins` is the allow list: the document URL must be on a listed origin, at every authorization and token
 * request, and each redirect URI must be on that same origin. A client from the list is linked to the Console resource,
 * which other clients cannot ask for. The token and revocation endpoints answer CORS for listed origins, without
 * credentials. The authorization endpoint and consent stay top-level pages on the app origin.
 */
export function consoleOAuthClients(options: ConsoleOAuthClientsOptions): BetterAuthPlugin[] {
  const { resource } = options
  return [
    lazyCimd({
      fetchClientMetadataResource: options.clientMetadataFetch ?? platformClientMetadataFetch,
      isMetadataDocumentUrlAllowed: clientId => listedConsoleOrigin(new URL(clientId).origin) !== undefined,
      onClientCreated: ({ client, context }) => linkConsoleResource(context, client.clientId, resource),
      onClientRefreshed: ({ client, context }) => linkConsoleResource(context, client.clientId, resource),
      originBoundFields: ["redirect_uris", "post_logout_redirect_uris", "client_uri"],
    }),
    {
      hooks: {
        after: [{
          handler: createAuthMiddleware(async (context) => {
            const origin = listedConsoleOrigin(context.headers?.get("origin"))
            if (!origin) return
            context.setHeader("access-control-allow-origin", origin)
            context.setHeader("vary", "Origin")
          }),
          matcher: context => corsPaths.includes(context.path ?? ""),
        }],
        before: [{
          handler: createAuthMiddleware(async (context) => {
            const authorize = context.path === "/oauth2/authorize"
            const source: unknown = authorize ? context.query : context.body
            const parameters = isRecord(source) ? source : {}
            const clientId = stringParameter(parameters.client_id)
            if (!clientId || !isClientMetadataDocumentUrl(clientId)) return
            const origin = listedClientOrigin(clientId)
            if (!authorize) return
            const redirect = stringParameter(parameters.redirect_uri)
            let redirectOrigin: string | undefined
            try {
              redirectOrigin = redirect ? new URL(redirect).origin : undefined
            }
            catch {}
            if (redirectOrigin !== origin) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: `The redirect_uri must be on ${origin}, the origin of the client.` })
            if (stringParameter(parameters.code_challenge_method) !== "S256" || !stringParameter(parameters.code_challenge)) {
              throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "A Console client must use PKCE with code_challenge_method=S256." })
            }
          }),
          matcher: context => context.path === "/oauth2/authorize" || context.path === "/oauth2/token" || context.path === "/oauth2/revoke",
        }],
      },
      id: "vitehub-console-oauth-clients",
      // A browser asks before it posts to the token or revocation endpoint from a listed origin.
      onRequest: async (request, context) => {
        if (request.method !== "OPTIONS") return
        const origin = listedConsoleOrigin(request.headers.get("origin"))
        const base = new URL(context.baseURL).pathname.replace(/\/+$/, "")
        if (!origin || !corsPaths.some(path => new URL(request.url).pathname === `${base}${path}`)) return
        return {
          response: new Response(null, {
            headers: {
              "access-control-allow-headers": "authorization, content-type, dpop",
              "access-control-allow-methods": "POST",
              "access-control-allow-origin": origin,
              "access-control-max-age": "600",
              "cache-control": "no-store",
              "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
            },
            status: 204,
          }),
        }
      },
    },
  ]
}

/** Options of {@link consoleMcpOAuth}. */
export interface ConsoleMcpOAuthOptions {
  /** The absolute URL of the MCP endpoint, the same as `console.mcp.resource`: `https://app.example.com/_vitehub/mcp`. */
  resource: string
  /**
   * The app's sign-in page. Better Auth sends a signed-out person here with a signed query. Defaults to the Console's
   * built-in sign-in page next to the resource, which signs in with email and password or the social providers.
   */
  loginPage?: string
  /** The page where a signed-in person allows or denies the client. Defaults to `loginPage`. */
  consentPage?: string
  /** The `iss` of the access tokens. Defaults to the resource origin with Better Auth's `/api/auth` base path. */
  issuer?: string
  /** The transport for client ID Metadata Documents of Consoles. See {@link ConsoleOAuthClientsOptions}. */
  clientMetadataFetch?: ClientMetadataResourceFetch
}

/**
 * The Better Auth plugins that let MCP clients and Consoles on other origins sign in with OAuth to an app with
 * `console: { auth: "app" }`. MCP clients register themselves and get tokens for the MCP resource. Consoles on
 * `console.origins` use a client ID Metadata Document and get short tokens for the Console resource, next to the MCP
 * resource (see {@link consoleOAuthClients}). The plugins come from the Better Auth that ViteHub uses, so they fit
 * `defineAuth()` without a second `@better-auth/oauth-provider`. The resources and the issuer are fixed, so a token
 * issued through another host, such as a preview, still names them.
 */
export function consoleMcpOAuth(options: ConsoleMcpOAuthOptions): BetterAuthPlugin[] {
  const resource = new URL(options.resource)
  const issuer = (options.issuer ?? `${resource.origin}/api/auth`).replace(/\/+$/, "")
  resource.pathname = resource.pathname.replace(/\/+$/, "")
  const loginPage = options.loginPage ?? new URL("sign-in", resource).pathname
  const consoleResource = consoleResourceOf(options.resource)
  return [
    // By default the plugin signs a token on every session read, which the Console never uses and which fails after the secret changes.
    jwt({ disableSettingJwtHeader: true, jwt: { issuer } }),
    oauthProvider({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultResources: [options.resource],
      consentPage: options.consentPage ?? loginPage,
      loginPage,
      resources: [options.resource, consoleResourceEntry(consoleResource)],
      scopes: ["openid", "profile", "email", "offline_access", ...consoleMcpScopes],
    }),
    consoleMcpNativeClients(),
    ...consoleOAuthClients({ resource: consoleResource, ...(options.clientMetadataFetch ? { clientMetadataFetch: options.clientMetadataFetch } : {}) }),
  ]
}

/**
 * The Better Auth plugins that let MCP clients sign in with OAuth to the Console: `jwt()` signs the access tokens and
 * `oauthProvider()` registers clients and issues them. A plugin that the Auth already has is kept as it is. The sign-in
 * page of the Console is also the login and consent page of the flow.
 */
export function consoleOAuthPlugins(options: { defaults?: boolean, mountBaseURL: string, origin: string, plugins: readonly { id?: string }[] | undefined, resource?: string }): BetterAuthPlugin[] {
  const present = new Set((options.plugins ?? []).map(plugin => plugin.id))
  const page = consoleAuthPath(options.mountBaseURL, "/_vitehub/sign-in")
  const resource = options.resource ?? `${options.origin}${consoleAuthPath(options.mountBaseURL, "/_vitehub/mcp")}`
  return [
    // By default the plugin signs a token on every session read, which the Console never uses and which fails after the secret changes.
    ...(present.has("jwt") || options.defaults === false ? [] : [jwt({ disableSettingJwtHeader: true })]),
    ...(present.has("oauth-provider") || options.defaults === false
      ? []
      : [
          oauthProvider({
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            clientRegistrationDefaultResources: [resource],
            consentPage: page,
            loginPage: page,
            resources: [resource],
            scopes: ["openid", "profile", "email", "offline_access", ...consoleMcpScopes],
          }),
        ]),
    // The hook has no schema and is needed even when the app supplies its own OAuth provider.
    ...(!present.has("vitehub-console-native-clients") && (present.has("oauth-provider") || options.defaults !== false) ? [consoleMcpNativeClients()] : []),
  ]
}
