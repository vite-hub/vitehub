import * as v from "valibot"

import { connectionError } from "../errors.ts"
import { assertConnectionOrigins, matchesConnectionOrigin } from "../origins.ts"

import type {
  ConnectionOAuthClient,
  ConnectionProvider,
  ConnectionProviderContext,
  ConnectionSecret,
  ConnectionTokenSet,
} from "../types.ts"

export interface OAuth2ProviderOptions {
  /** Maps the user info response to the account label. Default: `email`, then `sub`. */
  account?: (userInfo: Record<string, unknown>) => string | undefined
  /** Extra authorization request parameters. */
  authorizationParams?: Readonly<Record<string, string>>
  authorizationUrl: string
  /** OAuth client of this app. Called for each provider request, so it can read server env. */
  client: (context: { event?: unknown }) => ConnectionOAuthClient | Promise<ConnectionOAuthClient>
  /** How the client authenticates at the token endpoint. Default: `"body"`. */
  clientAuth?: "basic" | "body"
  /** Provider identifier shown in the Console. Default: `"oauth2"`. */
  id?: string
  /**
   * API origins that may receive the access token, for example `["https://api.example.com"]`.
   * `https://*.example.com` matches subdomains. Calls to other origins fail.
   */
  origins: readonly string[]
  revokeUrl?: string
  scopes: readonly string[]
  tokenUrl: string
  /** Returns the account label. It receives the access token, so its origin must be in `origins`. */
  userInfoUrl?: string
}

// Optional provider fields that have an unexpected type are ignored, not rejected.
const optionalString = v.fallback(v.optional(v.string()), undefined)
const tokenResponse = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  expires_in: v.fallback(v.optional(v.union([v.number(), v.pipe(v.string(), v.decimal(), v.toNumber())])), undefined),
  refresh_token: optionalString,
  scope: optionalString,
  token_type: optionalString,
})
const errorResponse = v.object({ error: v.string() })
const userInfoResponse = v.looseObject({ email: optionalString, sub: optionalString })

// ViteHub sets these for each flow. An override would break the state, redirect, or PKCE binding.
const reservedAuthorizationParams = new Set(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"])

/** `application/x-www-form-urlencoded` encoding for Basic credentials, as RFC 6749 section 2.3.1 requires. */
function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length)
}

function basicCredentials(id: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${formEncode(id)}:${formEncode(secret)}`)
  return `Basic ${btoa(String.fromCharCode(...bytes))}`
}

function secretValue(secret: ConnectionSecret | undefined): string | undefined {
  if (secret === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- ConnectionSecret is a typed union of a string and a sealed Secret Env value.
  return typeof secret === "string" ? secret : secret.unseal()
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined)
}

/** Creates an OAuth 2 authorization code provider with PKCE S256. */
export function oauth2(options: OAuth2ProviderOptions): ConnectionProvider {
  if (!options.authorizationUrl || !options.tokenUrl || !options.scopes.length) {
    throw connectionError("invalid", { path: "provider" })
  }
  const origins = assertConnectionOrigins(options.origins)
  // User info receives the access token, so it must be one of the API origins.
  if (options.userInfoUrl && !matchesConnectionOrigin(origins, new URL(options.userInfoUrl))) {
    throw connectionError("invalid", { path: "provider.userInfoUrl" })
  }
  for (const key of Object.keys(options.authorizationParams ?? {})) {
    if (reservedAuthorizationParams.has(key)) throw connectionError("invalid", { path: `provider.authorizationParams.${key}` })
  }
  const clientAuth = options.clientAuth ?? "body"

  async function client(context: ConnectionProviderContext): Promise<{ id: string, secret?: string }> {
    const value = await options.client({ event: context.event })
    if (!value?.clientId) throw connectionError("invalid", { path: "provider.client" })
    const secret = secretValue(value.clientSecret)
    return { id: value.clientId, ...(secret ? { secret } : {}) }
  }

  /** Form request with the configured client authentication. Token and revocation endpoints use it. */
  async function clientRequest(context: ConnectionProviderContext, url: string, params: Record<string, string>): Promise<Response> {
    const { id, secret } = await client(context)
    const body = new URLSearchParams(params)
    const headers: Record<string, string> = {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded",
    }
    if (clientAuth === "basic") {
      headers.authorization = basicCredentials(id, secret ?? "")
    }
    else {
      body.set("client_id", id)
      if (secret) body.set("client_secret", secret)
    }
    return context.fetch(url, { body, headers, method: "POST" })
  }

  async function tokenRequest(
    context: ConnectionProviderContext,
    params: Record<string, string>,
    previous?: ConnectionTokenSet,
  ): Promise<ConnectionTokenSet> {
    const response = await clientRequest(context, options.tokenUrl, params)
    const result: unknown = await readJson(response)
    const parsed = v.safeParse(tokenResponse, result)
    if (!response.ok || !parsed.success) {
      const error = v.safeParse(errorResponse, result)
      if (error.success && error.output.error === "invalid_grant") throw connectionError("needs_reconnect", { status: response.status })
      throw connectionError("provider_failed", { status: response.status })
    }
    const json = parsed.output
    const expiresIn = json.expires_in
    const scopes = json.scope ? json.scope.split(/[\s,]+/).filter(Boolean) : previous?.scopes ?? options.scopes
    const refreshToken = json.refresh_token ?? previous?.refreshToken
    return {
      accessToken: json.access_token,
      scopes,
      tokenType: json.token_type ?? "Bearer",
      ...(expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(previous?.account ? { account: previous.account } : {}),
    }
  }

  async function account(token: ConnectionTokenSet, context: ConnectionProviderContext): Promise<string | undefined> {
    if (!options.userInfoUrl) return
    const response = await context.fetch(options.userInfoUrl, {
      headers: { accept: "application/json", authorization: `Bearer ${token.accessToken}` },
    })
    if (!response.ok) return
    const info = v.safeParse(userInfoResponse, await readJson(response))
    if (!info.success) return
    if (options.account) return options.account(info.output)
    return info.output.email ?? info.output.sub
  }

  return {
    id: options.id ?? "oauth2",
    kind: "oauth2",
    origins,
    scopes: options.scopes,
    async authorizationUrl(input, context) {
      const { id } = await client(context)
      const url = new URL(options.authorizationUrl)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", id)
      url.searchParams.set("redirect_uri", input.redirectUri)
      url.searchParams.set("scope", options.scopes.join(" "))
      url.searchParams.set("state", input.state)
      url.searchParams.set("code_challenge", input.codeChallenge)
      url.searchParams.set("code_challenge_method", "S256")
      for (const [key, value] of Object.entries(options.authorizationParams ?? {})) url.searchParams.set(key, value)
      return url.toString()
    },
    async exchange(input, context) {
      const token = await tokenRequest(context, {
        code: input.code,
        code_verifier: input.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      })
      const label = await account(token, context)
      return label ? { ...token, account: label } : token
    },
    async refresh(token, context) {
      if (!token.refreshToken) throw connectionError("needs_reconnect")
      return tokenRequest(context, { grant_type: "refresh_token", refresh_token: token.refreshToken }, token)
    },
    ...(options.revokeUrl
      ? {
          async revoke(token: ConnectionTokenSet, context: ConnectionProviderContext) {
            const response = await clientRequest(context, options.revokeUrl!, token.refreshToken
              ? { token: token.refreshToken, token_type_hint: "refresh_token" }
              : { token: token.accessToken, token_type_hint: "access_token" })
            // RFC 7009 answers 200 for a token that is already invalid. Some providers answer 400 `invalid_token`.
            // Other 400 errors, such as `invalid_client`, mean the upstream token may still be active.
            if (response.ok) return
            const error = response.status === 400 ? v.safeParse(errorResponse, await readJson(response)) : undefined
            if (error?.success && error.output.error === "invalid_token") return
            throw connectionError("provider_failed", { status: response.status })
          },
        }
      : {}),
  }
}
