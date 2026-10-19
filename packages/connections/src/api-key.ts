import { ConnectionError } from "./errors.ts"

import type { ConnectionApiCatalog, ConnectionApiKeyFallback, ConnectionApiKeyProvider, ConnectionApiKeyVerification, ConnectionApiKeyVerifyContext, ConnectionDefinition, ConnectionRequestPolicy } from "./types.ts"

export interface ApiKeyProviderOptions<TApis extends object = object> {
  /** Provider id shown in inspection and the Console. Default: `"api-key"`. */
  id?: string
  /** Request header that carries the key. Default: `authorization`. */
  header?: string
  /**
   * Text before the key in the header value. Default: `Bearer` for `authorization`, none for other headers.
   * Set `""` to send the bare key.
   */
  scheme?: string
  /** Origins that `fetch` may send the key to, for example `["https://api.example.com"]`. */
  origins: readonly string[]
  /** Typed API catalogs. Their root URLs also receive the key. */
  apis?: { readonly [TApi in keyof TApis]: ConnectionApiCatalog }
  /** The provider's MCP endpoint, for example `https://mcp.example.com/mcp`. The key is also sent there. */
  mcp?: string
  /** Pacing, retries, and a timeout for provider requests. */
  requests?: ConnectionRequestPolicy
  /**
   * The key to use while no key was ever set in the Console or with `vitehub connections set-key`,
   * for example `() => useServerEnv().example.token`. A sealed Server Env secret is unsealed. It also
   * applies when the Connections store cannot open, such as a deployment without `VITEHUB_CONNECTIONS_KEY`.
   * A key that an admin sets always wins, and so does a revoke: a revoked Connection stays disconnected.
   * Set a key again to reconnect it.
   */
  fallback?: ConnectionApiKeyFallback
  /**
   * Check a new key before ViteHub stores it, for example with `context.fetch`.
   * Return `false` to reject the key, or `{ account }` to label the Connection.
   */
  verify?: (key: string, context: ConnectionApiKeyVerifyContext) => Promise<ConnectionApiKeyVerification>
}

// RFC 9110 token characters. Header names and authentication schemes use them.
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Whether a host name is a loopback host. Plain `http` is allowed only for these hosts. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/** Normalize an API key origin. Returns `undefined` for a URL with a path, query, credentials, or plain `http` to a remote host. */
function apiKeyOrigin(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return undefined
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return undefined
  return url.origin
}

/** Whether a credential may go to this endpoint URL: HTTPS or loopback, without credentials, query, or fragment. */
export function isSafeEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash && apiKeyOrigin(url.origin) !== undefined
  }
  catch {
    return false
  }
}

/** Whether the provider header and origins can carry a key safely. */
export function isValidApiKeyProvider(provider: { header: string, origins: readonly string[], scheme?: string }): boolean {
  try {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false
    const header = provider.header
    const candidateOrigins = provider.origins
    const scheme = provider.scheme
    if (typeof header !== "string" || !Array.isArray(candidateOrigins)) return false
    // structuredClone rejects Proxy values and gives us a stable, ordinary-array snapshot.
    const origins = structuredClone(candidateOrigins)
    if (Object.getPrototypeOf(origins) !== Array.prototype) return false
    const originIndexes = Object.getOwnPropertyNames(origins).filter(key => {
      const index = Number(key)
      return String(index) === key && index >= 0 && index < 2 ** 32 - 1
    })
    if (originIndexes.length !== origins.length) return false
    for (const key of originIndexes) {
      if (typeof origins[Number(key)] !== "string") return false
    }
    for (const key of originIndexes) {
      const origin = origins[Number(key)]
      if (apiKeyOrigin(origin) !== origin) return false
    }
    return tokenPattern.test(header)
      && header === header.toLowerCase()
      && (scheme === undefined || (() => {
        if (typeof scheme !== "string") return false
        return tokenPattern.test(scheme)
      })())
      && origins.length > 0
  }
  catch {
    return false
  }
}

export function isApiKeyProvider(provider: ConnectionDefinition["provider"]): provider is ConnectionApiKeyProvider {
  return Object.hasOwn(provider, "kind") && "kind" in provider && provider.kind === "api-key"
}

/** A provider for a static API key. An admin sets the key in the Console or with `vitehub connections set-key`. */
export function apiKey<const TApis extends object = object>(options: ApiKeyProviderOptions<TApis>): ConnectionApiKeyProvider<TApis> {
  const header = (options.header ?? "authorization").toLowerCase()
  const scheme = options.scheme === "" ? undefined : options.scheme ?? (header === "authorization" ? "Bearer" : undefined)
  const origins = options.origins.map(origin => apiKeyOrigin(origin))
  const id = options.id ?? "api-key"
  const provider: ConnectionApiKeyProvider<TApis> = {
    kind: "api-key",
    id,
    header,
    origins: origins.filter(origin => origin !== undefined),
    // SAFETY: An omitted catalog map is the empty map of the default `object` API type.
    apis: options.apis ?? ({} as ConnectionApiKeyProvider<TApis>["apis"]),
  }
  if (scheme !== undefined) Object.assign(provider, { scheme })
  if (options.mcp !== undefined) Object.assign(provider, { mcp: options.mcp })
  if (options.requests !== undefined) Object.assign(provider, { requests: options.requests })
  if (options.fallback) provider.fallback = options.fallback
  if (options.verify) provider.verify = options.verify
  // SAFETY: The provider API map is constrained by the generic catalog contract.
  const catalogsSafe = (Object.values(provider.apis) as ConnectionApiCatalog[]).every(catalog => {
    try {
      const url = new URL(catalog.rootUrl)
      return !url.username && !url.password && !url.search && !url.hash && apiKeyOrigin(catalog.rootUrl) !== undefined
    }
    catch {
      return false
    }
  })
  if (!/^\S+$/.test(id) || origins.includes(undefined) || !catalogsSafe || !isValidApiKeyProvider(provider)) {
    throw new ConnectionError("invalid", "The API key provider needs a token header name, a token scheme, and HTTPS or loopback origins without a path.")
  }
  if (options.mcp !== undefined && !isSafeEndpoint(options.mcp)) {
    throw new ConnectionError("invalid", "The API key provider mcp endpoint must be an HTTPS or loopback URL without credentials, query, or fragment.")
  }
  return provider
}
