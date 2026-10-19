import * as v from "valibot"

import { accountFromIdToken } from "../account.ts"
import { isSafeEndpoint } from "../api-key.ts"
import { ConnectionError, isConnectionError } from "../errors.ts"

import type { ConnectionAccount, ConnectionLoginDefinition, ConnectionLoginProvider, ConnectionValue } from "../types.ts"

// Refresh or sign in again this long before the access token expires.
const EXPIRY_WINDOW_MS = 60_000
const DISCOVERY_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 60_000

/** A token of a login provider. It lives only in the memory of one process. */
export interface LoginToken {
  accessToken: string
  account?: ConnectionAccount
  expiresAt?: number
  refreshToken?: string
  refreshedAt: string
  scopes: string[]
  tokenType: string
}

interface LoginSession {
  authorizationEndpoint: string
  clientId: string
  clientSecret?: string
  resource?: string
  tokenEndpoint: string
}

const tokenResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  expires_in: v.optional(v.number()),
  id_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
})
const resourceMetadataSchema = v.object({ authorization_servers: v.pipe(v.array(v.string()), v.minLength(1)) })
const safeEndpoint = v.pipe(v.string(), v.check(isSafeEndpoint))
const serverMetadataSchema = v.object({
  issuer: v.optional(v.string()),
  authorization_endpoint: safeEndpoint,
  token_endpoint: safeEndpoint,
  registration_endpoint: v.optional(safeEndpoint),
})
const registrationSchema = v.object({ client_id: v.pipe(v.string(), v.minLength(1)), client_secret: v.optional(v.string()) })
const sealedValueSchema = v.object({ unseal: v.function() })

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/** Protected resource metadata URLs of a resource: path inserted, then the root (RFC 9728, section 3.1). */
function resourceMetadataUrls(resource: string): string[] {
  const url = new URL(resource)
  const path = withoutTrailingSlash(url.pathname)
  return [...new Set([`${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`])]
}

/**
 * Authorization server metadata URLs of an issuer, in the order of the MCP authorization spec:
 * RFC 8414 with the path inserted, OpenID Connect discovery with the path inserted, then appended.
 */
function serverMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer)
  const path = withoutTrailingSlash(url.pathname)
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`]
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ]
}

async function resolveValue(value: ConnectionValue | undefined): Promise<string | undefined> {
  return typeof value === "string" || value === undefined ? value : await value()
}

/**
 * Sign-ins of login providers, by Connection name. Concurrent callers share one sign-in and its
 * failure. A token that expires within a minute, or that the provider rejected, is refreshed with its
 * refresh token, or replaced by a new sign-in.
 */
export function createLoginSessions(options: { now: () => number, request: typeof fetch }) {
  const { now, request } = options
  const sessions = new Map<string, Promise<LoginSession>>()
  const tokens = new Map<string, Promise<LoginToken>>()
  const settled = new Map<string, LoginToken>()

  /** The unsealed `credentials`: `""` without `credentials`, `undefined` while they resolve to nothing. */
  async function credentials(provider: ConnectionLoginProvider): Promise<string | undefined> {
    if (!provider.credentials) return ""
    let value: unknown = await provider.credentials()
    if (v.is(sealedValueSchema, value)) value = value.unseal()
    return typeof value === "string" && value.trim() ? value : undefined
  }

  async function readJson(url: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await request(url, { ...init, headers: { accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
      const body: unknown = await response.json().catch(() => undefined)
      return response.ok ? body : undefined
    }
    catch {
      return undefined
    }
  }

  /** Discover the authorization server, then register a public client unless the provider sets `clientId`. */
  async function discover(name: string, provider: ConnectionLoginProvider): Promise<LoginSession> {
    let issuer = provider.issuer
    if (!issuer && provider.mcp) {
      for (const url of resourceMetadataUrls(provider.mcp)) {
        const metadata = v.safeParse(resourceMetadataSchema, await readJson(url))
        if (metadata.success) {
          issuer = metadata.output.authorization_servers[0]
          break
        }
      }
    }
    if (!issuer || !isSafeEndpoint(issuer)) {
      throw new ConnectionError("provider", `Connection "${name}" found no authorization server for ${provider.mcp}.`, { details: { connection: name } })
    }
    let server: v.InferOutput<typeof serverMetadataSchema> | undefined
    for (const url of serverMetadataUrls(issuer)) {
      const metadata = v.safeParse(serverMetadataSchema, await readJson(url))
      // RFC 8414, section 3.3: the metadata must name the issuer that it was fetched for.
      if (metadata.success && (metadata.output.issuer === undefined || withoutTrailingSlash(metadata.output.issuer) === withoutTrailingSlash(issuer))) {
        server = metadata.output
        break
      }
    }
    if (!server) {
      throw new ConnectionError("provider", `Connection "${name}" found no authorization server metadata for ${issuer}.`, { details: { connection: name } })
    }
    let clientId = await resolveValue(provider.clientId)
    let clientSecret: string | undefined
    if (!clientId) {
      if (!server.registration_endpoint) {
        throw new ConnectionError("invalid", `The authorization server of Connection "${name}" does not register clients. Set the provider \`clientId\`.`, { details: { connection: name } })
      }
      const loopback = new URL(provider.redirectUri).protocol === "http:"
      const registration = v.safeParse(registrationSchema, await readJson(server.registration_endpoint, {
        body: JSON.stringify({
          application_type: loopback ? "native" : "web",
          client_name: provider.clientName ?? "ViteHub",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [provider.redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      if (!registration.success) {
        throw new ConnectionError("provider", `Connection "${name}" could not register a client at its authorization server.`, { details: { connection: name } })
      }
      clientId = registration.output.client_id
      clientSecret = registration.output.client_secret
    }
    return {
      authorizationEndpoint: server.authorization_endpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(provider.resource ?? provider.mcp ? { resource: provider.resource ?? provider.mcp } : {}),
      tokenEndpoint: server.token_endpoint,
    }
  }

  /** The discovered session of a Connection. It is kept for the process; a failed discovery is retried. */
  function session(name: string, provider: ConnectionLoginProvider): Promise<LoginSession> {
    let pending = sessions.get(name)
    if (!pending) {
      pending = discover(name, provider)
      sessions.set(name, pending)
      pending.catch(() => {
        if (sessions.get(name) === pending) sessions.delete(name)
      })
    }
    return pending
  }

  /**
   * A fetch that acts as one browser session: it keeps cookies per host, sends `origin`, resolves
   * relative URLs against `base`, and does not follow redirects unless `init.redirect` asks for it.
   */
  function browserFetch(base: URL, signal: AbortSignal): (input: string | URL, init?: RequestInit) => Promise<Response> {
    const jar = new Map<string, Map<string, string>>()
    return async (input, init = {}) => {
      const url = new URL(input, base)
      const headers = new Headers(init.headers)
      const cookies = jar.get(url.host)
      if (cookies?.size && !headers.has("cookie")) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      if (!headers.has("origin")) headers.set("origin", url.origin)
      const response = await request(url.toString(), { ...init, headers, redirect: init.redirect ?? "manual", signal: init.signal ?? signal })
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = cookie.split(";")
        const separator = pair.indexOf("=")
        if (separator < 1) continue
        const key = pair.slice(0, separator).trim()
        const value = pair.slice(separator + 1).trim()
        let hostCookies = jar.get(url.host)
        if (!hostCookies) jar.set(url.host, hostCookies = new Map())
        if (!value || attributes.some(attribute => /^\s*max-age\s*=\s*0\s*$/i.test(attribute))) hostCookies.delete(key)
        else hostCookies.set(key, value)
      }
      return response
    }
  }

  async function tokenRequest(name: string, current: LoginSession, parameters: Record<string, string>, signal: AbortSignal): Promise<v.InferOutput<typeof tokenResponseSchema>> {
    const response = await request(current.tokenEndpoint, {
      body: new URLSearchParams({
        ...parameters,
        client_id: current.clientId,
        ...(current.clientSecret ? { client_secret: current.clientSecret } : {}),
        ...(current.resource ? { resource: current.resource } : {}),
      }),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal,
    })
    const body: unknown = await response.json().catch(() => undefined)
    const token = v.safeParse(tokenResponseSchema, body)
    if (!response.ok || !token.success) {
      const error = v.safeParse(v.object({ error: v.string() }), body)
      throw new ConnectionError("provider", `Connection "${name}" could not get a token${error.success ? ` (${error.output.error.slice(0, 100)})` : ""}.`, { details: { connection: name, status: response.status } })
    }
    return token.output
  }

  function toToken(definition: ConnectionLoginDefinition, response: v.InferOutput<typeof tokenResponseSchema>, previous?: LoginToken): LoginToken {
    const scopes = definition.scopes ?? []
    const account = definition.provider.account ? definition.provider.account(response) : scopes.includes("openid") ? accountFromIdToken(response.id_token) : undefined
    return {
      accessToken: response.access_token,
      account: account ?? previous?.account,
      expiresAt: response.expires_in === undefined ? undefined : now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? previous?.refreshToken,
      refreshedAt: new Date(now()).toISOString(),
      scopes: response.scope?.split(/\s+/).filter(Boolean) ?? [...scopes],
      tokenType: response.token_type ?? "Bearer",
    }
  }

  /** Refresh `previous` when it has a refresh token, else sign in through `login` with the authorization code flow. */
  async function signIn(name: string, definition: ConnectionLoginDefinition, previous: LoginToken | undefined): Promise<LoginToken> {
    const provider = definition.provider
    const signal = AbortSignal.timeout(LOGIN_TIMEOUT_MS)
    const current = await session(name, provider)
    if (previous?.refreshToken) {
      try {
        return toToken(definition, await tokenRequest(name, current, { grant_type: "refresh_token", refresh_token: previous.refreshToken }, signal), previous)
      }
      catch {
        // A rejected refresh token falls back to a new sign-in.
      }
    }
    const secret = await credentials(provider)
    if (secret === undefined) throw new ConnectionError("reauth_required", `Connection "${name}" has no login credentials.`, { details: { connection: name } })
    const verifier = randomToken()
    const state = randomToken()
    const url = new URL(current.authorizationEndpoint)
    for (const [parameter, value] of Object.entries({
      ...provider.authorizationParams,
      client_id: current.clientId,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: "S256",
      redirect_uri: provider.redirectUri,
      ...(current.resource ? { resource: current.resource } : {}),
      response_type: "code",
      scope: (definition.scopes ?? []).join(" "),
      state,
    })) if (value) url.searchParams.set(parameter, value)
    let returned: unknown
    try {
      returned = await provider.login({ credentials: secret, fetch: browserFetch(url, signal), redirectUri: provider.redirectUri, signal, url: url.toString() })
    }
    catch (error) {
      // A login failure message could contain the credentials, so only Connection errors pass through.
      if (isConnectionError(error)) throw error
      throw new ConnectionError("provider", `The login of Connection "${name}" failed.`, { details: { connection: name } })
    }
    let callback: URL | undefined
    try {
      callback = new URL(String(returned))
    }
    catch {}
    const redirect = new URL(provider.redirectUri)
    if (!callback || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
      throw new ConnectionError("provider", `The login of Connection "${name}" must return the URL that the provider redirects to ${provider.redirectUri}.`, { details: { connection: name } })
    }
    const error = callback.searchParams.get("error")
    if (error) throw new ConnectionError("provider", `Provider "${provider.id}" rejected the login of Connection "${name}" (${error.slice(0, 100)}).`, { details: { connection: name } })
    const code = callback.searchParams.get("code")
    if (!code || callback.searchParams.get("state") !== state) {
      throw new ConnectionError("provider", `The login of Connection "${name}" returned no authorization code for this request.`, { details: { connection: name } })
    }
    return toToken(definition, await tokenRequest(name, current, { code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: provider.redirectUri }, signal))
  }

  function expiresSoon(token: LoginToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - now() < EXPIRY_WINDOW_MS
  }

  /**
   * A valid access token. `stale` is a token the provider rejected: a caller that passes it gets a
   * newer token. Concurrent callers share one sign-in.
   */
  async function token(name: string, definition: ConnectionLoginDefinition, stale?: string): Promise<LoginToken> {
    while (true) {
      const cached = tokens.get(name)
      // Callers that arrive during a sign-in share its result, also a failure.
      const current = cached ? await cached : undefined
      if (current && current.accessToken !== stale && !expiresSoon(current)) return current
      // Another caller replaced the token while this one waited. Check the replacement.
      if (cached && tokens.get(name) !== cached) continue
      const pending = signIn(name, definition, current)
      tokens.set(name, pending)
      pending.then((next) => {
        if (tokens.get(name) === pending) settled.set(name, next)
      }, () => {
        if (tokens.get(name) !== pending) return
        tokens.delete(name)
        // The client may be gone at the provider. Discover and register again on the next sign-in.
        sessions.delete(name)
      })
      return await pending
    }
  }

  /** Forget the tokens and the session of a Connection. The next request signs in again. */
  function forget(name: string): void {
    tokens.delete(name)
    settled.delete(name)
    sessions.delete(name)
  }

  return {
    credentials,
    forget,
    /** The latest token of a Connection, for inspection. */
    latest: (name: string) => settled.get(name),
    token,
  }
}
