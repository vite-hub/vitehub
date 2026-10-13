import { ConnectionError } from "./errors.ts"

import type { ConnectionApiCatalog, ConnectionApiKeyProvider, ConnectionApiKeyVerification, ConnectionApiKeyVerifyContext, ConnectionDefinition } from "./types.ts"

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
export function apiKeyOrigin(value: string): string | undefined {
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

/** Whether the provider header and origins can carry a key safely. */
export function isValidApiKeyProvider(provider: { header: string, origins: readonly string[], scheme?: string }): boolean {
  return tokenPattern.test(provider.header)
    && provider.header === provider.header.toLowerCase()
    && (provider.scheme === undefined || tokenPattern.test(provider.scheme))
    && provider.origins.length > 0
    && provider.origins.every(origin => apiKeyOrigin(origin) === origin)
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
  return provider
}
