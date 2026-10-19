import { apiKeyOrigin, isLoopbackHost, isSafeEndpoint } from "./api-key.ts"
import { ConnectionError } from "./errors.ts"

import type {
  ConnectionAccount,
  ConnectionApiCatalog,
  ConnectionApiKeyFallback,
  ConnectionDefinition,
  ConnectionLoginContext,
  ConnectionLoginProvider,
  ConnectionRequestPolicy,
  ConnectionTokenResponse,
  ConnectionValue,
} from "./types.ts"

const DEFAULT_REDIRECT_URI = "http://127.0.0.1/callback"

export interface OAuthLoginProviderOptions<TApis extends object = object> {
  /** Provider id shown in inspection and the Console. Default: `"oauth-login"`. */
  id?: string
  /**
   * The provider's MCP endpoint, for example `https://mcp.example.com/mcp`. ViteHub finds the
   * authorization server in its protected resource metadata (RFC 9728), and the token is sent there.
   */
  mcp?: string
  /** The authorization server issuer (RFC 8414), when there is no `mcp` endpoint or it has no resource metadata. */
  issuer?: string
  /** The `resource` of authorization and token requests (RFC 8707). Default: `mcp`. */
  resource?: string
  /** Other origins that `fetch` may send the token to, for example `["https://api.example.com"]`. */
  origins?: readonly string[]
  /** Typed API catalogs. Their root URLs also receive the token. */
  apis?: { readonly [TApi in keyof TApis]: ConnectionApiCatalog }
  /** A registered public client id. Without it, ViteHub registers a client (RFC 7591) once per process. */
  clientId?: ConnectionValue
  /** `client_name` for client registration. Default: `"ViteHub"`. */
  clientName?: string
  /** The redirect URI of the client. ViteHub never listens on it. Default: `http://127.0.0.1/callback`. */
  redirectUri?: string
  /** Extra authorization request parameters. */
  authorizationParams?: Readonly<Record<string, string>>
  /**
   * The service account secret that `login` uses, for example `() => useServerEnv().example.login`.
   * A sealed Server Env secret is unsealed. While it resolves to nothing, the Connection is disconnected.
   */
  credentials?: ConnectionApiKeyFallback
  /**
   * Sign in and approve the authorization request without a person, like a browser would: open
   * `context.url` with `context.fetch` and return the URL that the provider redirects to `redirectUri`.
   */
  login: (context: ConnectionLoginContext) => Promise<string>
  /** Read the account from a token response. Default: the ID token when `scopes` includes `openid`. */
  account?: (token: ConnectionTokenResponse) => ConnectionAccount | undefined
  /** Pacing, retries, and a timeout for provider requests. */
  requests?: ConnectionRequestPolicy
}

export function isLoginProvider(provider: ConnectionDefinition["provider"]): provider is ConnectionLoginProvider {
  return Object.hasOwn(provider, "kind") && "kind" in provider && provider.kind === "oauth-login"
}

/** Whether a login provider has a discovery source, safe endpoints, a safe redirect URI, and origins without a path. */
export function isValidLoginProvider(provider: Pick<ConnectionLoginProvider, "issuer" | "mcp" | "origins" | "redirectUri" | "resource">): boolean {
  const endpoints = [provider.mcp, provider.issuer, provider.resource].filter(value => value !== undefined)
  let redirect: URL
  try {
    redirect = new URL(provider.redirectUri)
  }
  catch {
    return false
  }
  return (provider.mcp !== undefined || provider.issuer !== undefined)
    && endpoints.every(endpoint => typeof endpoint === "string" && isSafeEndpoint(endpoint))
    && !redirect.hash
    && (redirect.protocol === "https:" || (redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)))
    && Array.isArray(provider.origins)
    && provider.origins.every(origin => typeof origin === "string" && apiKeyOrigin(origin) === origin)
}

/**
 * An OAuth 2.0 provider that connects without a person, for a service account. ViteHub discovers the
 * authorization server, registers a client, runs the authorization code flow with PKCE, `state`, and
 * `resource`, and refreshes or signs in again before the token expires and once after a `401`. `login`
 * plays the browser. Tokens stay in memory, so each process signs in again. There is no connect flow.
 */
export function oauthLogin<const TApis extends object = object>(options: OAuthLoginProviderOptions<TApis>): ConnectionLoginProvider<TApis> {
  const provider: ConnectionLoginProvider<TApis> = {
    kind: "oauth-login",
    id: options.id ?? "oauth-login",
    login: options.login,
    origins: (options.origins ?? []).map(origin => apiKeyOrigin(origin) ?? origin),
    redirectUri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
  }
  if (options.mcp !== undefined) Object.assign(provider, { mcp: options.mcp })
  if (options.issuer !== undefined) Object.assign(provider, { issuer: options.issuer })
  if (options.resource !== undefined) Object.assign(provider, { resource: options.resource })
  if (options.apis !== undefined) Object.assign(provider, { apis: options.apis })
  if (options.clientId !== undefined) Object.assign(provider, { clientId: options.clientId })
  if (options.clientName !== undefined) Object.assign(provider, { clientName: options.clientName })
  if (options.authorizationParams !== undefined) Object.assign(provider, { authorizationParams: options.authorizationParams })
  if (options.credentials !== undefined) Object.assign(provider, { credentials: options.credentials })
  if (options.requests !== undefined) Object.assign(provider, { requests: options.requests })
  if (options.account) provider.account = options.account
  // SAFETY: The provider API map is constrained by the generic catalog contract.
  const catalogs = Object.values(provider.apis ?? {}) as ConnectionApiCatalog[]
  if (!/^\S+$/.test(provider.id) || typeof provider.login !== "function" || !isValidLoginProvider(provider) || !catalogs.every(catalog => isSafeEndpoint(catalog.rootUrl))) {
    throw new ConnectionError("invalid", "The OAuth login provider needs `login`, an `mcp` or `issuer` HTTPS or loopback URL, an HTTPS or loopback `redirectUri`, and origins without a path.")
  }
  return provider
}
