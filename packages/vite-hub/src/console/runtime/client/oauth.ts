/**
 * OAuth sign-in of a hosted Console to a project with `console: { auth: "app" }`: the authorization code flow with PKCE
 * `S256` (RFC 7636), as a public client that its client ID Metadata Document names. The app's Better Auth is the
 * authorization server. The Console reads the protected resource metadata (RFC 9728) and the authorization server
 * metadata (RFC 8414), sends the browser to the authorization endpoint, and exchanges the code for short access tokens
 * and a refresh token. The tokens stay in this browser with the project.
 */

import { consoleOAuthCallbackPath, consoleOAuthClientPath, consoleOAuthScope } from "../../hosted/oauth-client"

import type { ConsoleLinkPage } from "./pending-links"
import type { ConsoleProjectProblem } from "./project-link"
import type { ConsoleProjectStorage, ConsoleProjectTarget } from "./projects"

/** The `sessionStorage` key of the sign-ins that wait for their callback. */
export const consoleOAuthStateStorageKey = "vitehub-console:oauth-sign-ins"

/** A sign-in that does not come back within this time, in milliseconds, cannot finish. */
export const consoleOAuthStateLifetime: number = 10 * 60 * 1000

/** The Console refreshes an access token that expires within this time, in milliseconds. */
export const consoleOAuthRefreshMargin: number = 60 * 1000

/** The OAuth tokens of a linked project, and where to refresh and revoke them. */
export interface ConsoleOAuthTokens {
  accessToken: string
  /** The refresh token. Without one, the person signs in again when the access token expires. */
  refreshToken?: string
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt: number
  scope?: string
  /** The authorization server, the `iss` of the tokens. */
  issuer: string
  clientId: string
  /** The Console resource of the project, `<origin><base>/_vitehub`. */
  resource: string
  tokenEndpoint: string
  revocationEndpoint?: string
}

/** A sign-in that left for the authorization server and waits for its callback in this tab. */
export interface ConsoleOAuthPendingSignIn {
  state: string
  verifier: string
  /** The project URL, the key of the linked project. */
  projectUrl: string
  /** When the sign-in started, in milliseconds since the epoch. */
  createdAt: number
  issuer: string
  clientId: string
  redirectUri: string
  resource: string
  tokenEndpoint: string
  revocationEndpoint?: string
  /**
   * The authorization server sends `iss` with its answer (RFC 9207), so the callback must name `issuer`. The callback
   * never gives an endpoint: the token request goes to the `tokenEndpoint` of this sign-in.
   */
  issuerInResponse: boolean
}

/** The members of `fetch` that the OAuth requests use, so tests can pass a function. */
export type ConsoleOAuthFetch = (input: string, init?: RequestInit) => Promise<Response>

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** A PKCE code verifier: 32 random bytes, base64url, so 43 characters from the unreserved set of RFC 7636. */
export function createConsoleCodeVerifier(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

/** The `S256` code challenge of a verifier: the base64url SHA-256 of its ASCII bytes. */
export async function consoleCodeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

/** A random `state`: 16 random bytes, base64url. */
export function createConsoleOAuthState(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(16)))
}

// doctor-disable-next-line typescript/strict/no-runtime-typeof -- OAuth documents and stored JSON are untrusted.
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined

function field(value: unknown, key: string): unknown {
  return value instanceof Object ? Reflect.get(value, key) : undefined
}

/** An endpoint URL that the Console may call: `https:`, or `http:` on a loopback host. */
function endpoint(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname))) return url.href
  }
  catch {}
  return undefined
}

/** Read stored tokens. Returns `undefined` for a value that is not complete. */
export function parseConsoleOAuthTokens(value: unknown): ConsoleOAuthTokens | undefined {
  const accessToken = text(field(value, "accessToken"))
  const expiresAt: unknown = field(value, "expiresAt")
  const issuer = text(field(value, "issuer"))
  const clientId = text(field(value, "clientId"))
  const resource = text(field(value, "resource"))
  const tokenEndpoint = endpoint(field(value, "tokenEndpoint"))
  if (!accessToken || !Number.isFinite(expiresAt) || !issuer || !clientId || !resource || !tokenEndpoint) return undefined
  const refreshToken = text(field(value, "refreshToken"))
  const scope = text(field(value, "scope"))
  const revocationEndpoint = endpoint(field(value, "revocationEndpoint"))
  return {
    accessToken,
    clientId,
    expiresAt: Number(expiresAt),
    issuer,
    resource,
    tokenEndpoint,
    ...(refreshToken ? { refreshToken } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(scope ? { scope } : {}),
  }
}

/** The client of this Console: its `client_id` and its `redirect_uri`, from its client ID Metadata Document. */
export interface ConsoleOAuthClient {
  clientId: string
  redirectUri: string
}

/**
 * Read the client ID Metadata Document of this Console at `/oauth-client.json` and check that it names this origin. The
 * hosted build writes it for `VITEHUB_CONSOLE_ORIGIN`, so a Console that runs on another origin cannot sign in.
 */
export async function loadConsoleOAuthClient(pageOrigin: string, request: ConsoleOAuthFetch): Promise<{ client: ConsoleOAuthClient } | { problem: ConsoleProjectProblem }> {
  const clientId = `${pageOrigin}${consoleOAuthClientPath}`
  const redirectUri = `${pageOrigin}${consoleOAuthCallbackPath}`
  const missing = { title: "This Console cannot sign in with OAuth", message: `${pageOrigin} has no client document at ${consoleOAuthClientPath}. Build the Console with \`build:console-hosted\` and \`VITEHUB_CONSOLE_ORIGIN=${pageOrigin}\`, and serve the whole build output.` }
  let document: unknown
  try {
    const response = await request(clientId, { cache: "no-store", credentials: "omit" })
    document = response.ok ? await response.json() : undefined
  }
  catch {
    return { problem: missing }
  }
  if (!document) return { problem: missing }
  const named = text(field(document, "client_id"))
  const redirects: unknown = field(document, "redirect_uris")
  if (named !== clientId || !Array.isArray(redirects) || !redirects.includes(redirectUri)) {
    const built = named ? new URL(named).origin : "another origin"
    return { problem: { title: "This Console was built for another origin", message: `Its client document names ${built}, but this page runs on ${pageOrigin}. Build the Console again with \`VITEHUB_CONSOLE_ORIGIN=${pageOrigin}\`.` } }
  }
  return { client: { clientId, redirectUri } }
}

/** What the Console found in the OAuth metadata of a project. */
export interface ConsoleOAuthDiscovery {
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint?: string
  /** `authorization_response_iss_parameter_supported` of the server metadata. */
  issuerInResponse: boolean
}

async function readJson(request: ConsoleOAuthFetch, url: string): Promise<unknown> {
  const response = await request(url, { cache: "no-store", credentials: "omit", headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`${url} answered with status ${response.status}.`)
  return await response.json()
}

/** The RFC 8414 metadata URL of an issuer: the well-known path goes between the origin and the issuer path. */
export function consoleAuthorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.origin}/.well-known/oauth-authorization-server${path}`
}

/**
 * Read the protected resource metadata that the project's `401` named, then the metadata of its authorization server.
 * The resource must be the Console resource of the project, `<origin><base>/_vitehub`, so a document of another app
 * cannot take the sign-in. The server must support PKCE `S256` and client ID Metadata Documents.
 */
export async function discoverConsoleOAuth(
  target: ConsoleProjectTarget,
  resourceMetadata: string,
  context: { consoleOrigin: string, fetch: ConsoleOAuthFetch },
): Promise<{ discovery: ConsoleOAuthDiscovery } | { problem: ConsoleProjectProblem }> {
  const host = `${new URL(target.origin).host}${target.base}`
  const unreachable = { title: `Cannot read the sign-in settings of ${host}`, message: `${host} did not send its sign-in settings. If the app is online, add ${context.consoleOrigin} to its \`console.origins\` and redeploy.` }
  const metadataUrl = endpoint(resourceMetadata)
  if (!metadataUrl) return { problem: { title: `${host} sent an invalid sign-in challenge`, message: "Its resource_metadata is not an https:// URL. Update vite-hub in the project." } }
  let resourceDocument: unknown
  try {
    resourceDocument = await readJson(context.fetch, metadataUrl)
  }
  catch {
    return { problem: unreachable }
  }
  const resource = text(field(resourceDocument, "resource"))
  const expected = `${target.url}/_vitehub`
  if (resource !== expected) {
    return { problem: { title: `${host} names another resource`, message: `Its sign-in settings are for ${resource ?? "no resource"}, not ${expected}. Check the project URL. With a proxy, forward the public Host header.` } }
  }
  const servers: unknown = field(resourceDocument, "authorization_servers")
  // The issuer must match the server metadata exactly (RFC 8414), so it keeps the form of the document.
  const issuer = Array.isArray(servers) ? text(servers[0]) : undefined
  if (!issuer || !endpoint(issuer)) return { problem: { title: `${host} names no sign-in server`, message: "Its protected resource metadata has no https:// authorization server. Add `consoleMcpOAuth()` to the app Auth." } }
  let serverDocument: unknown
  try {
    serverDocument = await readJson(context.fetch, consoleAuthorizationServerMetadataUrl(issuer))
  }
  catch {
    return { problem: unreachable }
  }
  const authorizationEndpoint = endpoint(field(serverDocument, "authorization_endpoint"))
  const tokenEndpoint = endpoint(field(serverDocument, "token_endpoint"))
  const revocationEndpoint = endpoint(field(serverDocument, "revocation_endpoint"))
  if (text(field(serverDocument, "issuer")) !== issuer || !authorizationEndpoint || !tokenEndpoint) {
    return { problem: { title: `The sign-in server of ${host} does not match`, message: `Its metadata does not name ${issuer} as the issuer with an authorization and a token endpoint. Check the issuer of \`consoleMcpOAuth()\`.` } }
  }
  const methods: unknown = field(serverDocument, "code_challenge_methods_supported")
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    return { problem: { title: `${host} does not support PKCE`, message: "The Console signs in only with PKCE S256. Update vite-hub in the project." } }
  }
  if (field(serverDocument, "client_id_metadata_document_supported") !== true) {
    return { problem: { title: `${host} cannot sign this Console in`, message: "Its Auth does not accept client ID Metadata Documents. Install @better-auth/cimd at the version of better-auth, then redeploy." } }
  }
  return {
    discovery: {
      authorizationEndpoint,
      issuer,
      issuerInResponse: field(serverDocument, "authorization_response_iss_parameter_supported") === true,
      resource,
      tokenEndpoint,
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
    },
  }
}

/** The authorization URL of a sign-in, with PKCE `S256`, the Console resource, and the Console scopes. */
export function consoleAuthorizationUrl(pending: ConsoleOAuthPendingSignIn, authorizationEndpoint: string, challenge: string): string {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", pending.clientId)
  url.searchParams.set("redirect_uri", pending.redirectUri)
  url.searchParams.set("scope", consoleOAuthScope)
  url.searchParams.set("resource", pending.resource)
  url.searchParams.set("state", pending.state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.href
}

function parsePending(value: unknown): ConsoleOAuthPendingSignIn | undefined {
  const keys = ["state", "verifier", "projectUrl", "issuer", "clientId", "redirectUri", "resource", "tokenEndpoint"] as const
  const values = Object.fromEntries(keys.map(key => [key, text(field(value, key))]))
  const createdAt: unknown = field(value, "createdAt")
  if (keys.some(key => !values[key]) || !Number.isFinite(createdAt)) return undefined
  const revocationEndpoint = text(field(value, "revocationEndpoint"))
  return {
    clientId: values.clientId!,
    createdAt: Number(createdAt),
    issuer: values.issuer!,
    issuerInResponse: field(value, "issuerInResponse") === true,
    projectUrl: values.projectUrl!,
    redirectUri: values.redirectUri!,
    resource: values.resource!,
    state: values.state!,
    tokenEndpoint: values.tokenEndpoint!,
    verifier: values.verifier!,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  }
}

/** What a callback found for its `state`. */
export type ConsoleOAuthStateLookup =
  | { kind: "pending", signIn: ConsoleOAuthPendingSignIn }
  | { kind: "expired", signIn: ConsoleOAuthPendingSignIn }
  | { kind: "unknown" }

/** The sign-ins of one tab that wait for their callback. Each `state` works once. */
export interface ConsoleOAuthStateStore {
  save(signIn: ConsoleOAuthPendingSignIn): void
  /** Find and remove the sign-in of a `state`. A second call with the same `state` finds nothing. */
  take(state: string): ConsoleOAuthStateLookup
}

/** The sign-ins in `sessionStorage`, so they stay with the tab that started them. `now` is for tests. */
export function createConsoleOAuthStateStore(storage: ConsoleProjectStorage, options: { now?: () => number } = {}): ConsoleOAuthStateStore {
  const now = options.now ?? Date.now
  const read = (): ConsoleOAuthPendingSignIn[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(consoleOAuthStateStorageKey) ?? "[]")
      return (Array.isArray(value) ? value : []).map(parsePending).filter(entry => entry !== undefined)
    }
    catch {
      return []
    }
  }
  const live = (signIn: ConsoleOAuthPendingSignIn, time: number): boolean => time - signIn.createdAt <= consoleOAuthStateLifetime && signIn.createdAt <= time + 60_000
  const write = (entries: ConsoleOAuthPendingSignIn[]): void => {
    storage.setItem(consoleOAuthStateStorageKey, JSON.stringify(entries))
  }
  return {
    save(signIn) {
      const time = now()
      write([...read().filter(entry => live(entry, time) && entry.state !== signIn.state), signIn])
    },
    take(state) {
      const time = now()
      const entries = read()
      const signIn = entries.find(entry => entry.state === state)
      write(entries.filter(entry => entry !== signIn && live(entry, time)))
      if (!signIn) return { kind: "unknown" }
      return live(signIn, time) ? { kind: "pending", signIn } : { kind: "expired", signIn }
    },
  }
}

/** What the authorization server sent back to `/oauth/callback`. */
export type ConsoleOAuthCallback =
  | { kind: "code", code: string, state: string, issuer?: string }
  | { kind: "error", error: string, description?: string, state?: string, issuer?: string }
  | { kind: "invalid" }

/** Read the query of `/oauth/callback`, such as `?code=…&state=…&iss=…` or `?error=access_denied&state=…`. */
export function parseConsoleOAuthCallback(search: string): ConsoleOAuthCallback {
  const params = new URLSearchParams(search)
  const state = text(params.get("state"))
  const issuer = text(params.get("iss"))
  const error = text(params.get("error"))
  if (error) {
    const description = text(params.get("error_description"))
    return { kind: "error", error, ...(description ? { description: description.slice(0, 300) } : {}), ...(state ? { state } : {}), ...(issuer ? { issuer } : {}) }
  }
  const code = text(params.get("code"))
  if (!code || !state) return { kind: "invalid" }
  return { kind: "code", code, state, ...(issuer ? { issuer } : {}) }
}

/** The answer of a token request. */
export type ConsoleOAuthTokenResult =
  | { kind: "tokens", tokens: ConsoleOAuthTokens }
  /** The server did not issue tokens. A temporary failure does not invalidate the stored refresh token. */
  | { kind: "rejected", error?: string, description?: string, retryable?: boolean }
  /** The request failed before an answer, from CORS, the network, or a server that is offline. */
  | { kind: "unreachable" }

async function requestTokens(
  context: Pick<ConsoleOAuthTokens, "clientId" | "issuer" | "resource" | "revocationEndpoint" | "tokenEndpoint">,
  body: Record<string, string>,
  options: { fetch: ConsoleOAuthFetch, now: () => number, refreshToken?: string },
): Promise<ConsoleOAuthTokenResult> {
  let response: Response
  try {
    response = await options.fetch(context.tokenEndpoint, {
      body: new URLSearchParams({ ...body, client_id: context.clientId, resource: context.resource }).toString(),
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  }
  catch {
    return { kind: "unreachable" }
  }
  const answer: unknown = await response.json().catch(() => undefined)
  const accessToken = text(field(answer, "access_token"))
  const tokenType = text(field(answer, "token_type"))
  if (!response.ok || !accessToken || tokenType?.toLowerCase() !== "bearer") {
    const error = text(field(answer, "error"))
    const description = text(field(answer, "error_description"))
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500 || error === "server_error" || error === "temporarily_unavailable"
    return { kind: "rejected", ...(error ? { error } : {}), ...(description ? { description: description.slice(0, 300) } : {}), ...(retryable ? { retryable: true } : {}) }
  }
  const expiresIn: unknown = field(answer, "expires_in")
  // Without `expires_in`, the Console assumes 5 minutes and refreshes early rather than late.
  const seconds = Number.isFinite(expiresIn) && Number(expiresIn) > 0 ? Number(expiresIn) : 300
  const refreshToken = text(field(answer, "refresh_token")) ?? options.refreshToken
  const scope = text(field(answer, "scope"))
  return {
    kind: "tokens",
    tokens: {
      accessToken,
      clientId: context.clientId,
      expiresAt: options.now() + seconds * 1000,
      issuer: context.issuer,
      resource: context.resource,
      tokenEndpoint: context.tokenEndpoint,
      ...(refreshToken ? { refreshToken } : {}),
      ...(context.revocationEndpoint ? { revocationEndpoint: context.revocationEndpoint } : {}),
      ...(scope ? { scope } : {}),
    },
  }
}

/** Exchange the code of a callback for tokens, with the verifier of its sign-in. */
export function exchangeConsoleOAuthCode(signIn: ConsoleOAuthPendingSignIn, code: string, options: { fetch: ConsoleOAuthFetch, now?: () => number }): Promise<ConsoleOAuthTokenResult> {
  return requestTokens(signIn, {
    code,
    code_verifier: signIn.verifier,
    grant_type: "authorization_code",
    redirect_uri: signIn.redirectUri,
  }, { fetch: options.fetch, now: options.now ?? Date.now })
}

/** Ask for a new access token with the refresh token. The server rotates the refresh token. */
export function refreshConsoleOAuthTokens(tokens: ConsoleOAuthTokens, options: { fetch: ConsoleOAuthFetch, now?: () => number }): Promise<ConsoleOAuthTokenResult> {
  if (!tokens.refreshToken) return Promise.resolve({ kind: "rejected", error: "invalid_grant", description: "No refresh token." })
  return requestTokens(tokens, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, { fetch: options.fetch, now: options.now ?? Date.now, refreshToken: tokens.refreshToken })
}

/**
 * Revoke the refresh token at the revocation endpoint (RFC 7009), so it cannot get new access tokens. Best effort:
 * returns whether the server confirmed. The access token stays valid until it expires.
 */
export async function revokeConsoleOAuthTokens(tokens: ConsoleOAuthTokens, options: { fetch: ConsoleOAuthFetch }): Promise<boolean> {
  if (!tokens.revocationEndpoint) return false
  const token = tokens.refreshToken ?? tokens.accessToken
  try {
    const response = await options.fetch(tokens.revocationEndpoint, {
      body: new URLSearchParams({ client_id: tokens.clientId, token, token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token" }).toString(),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // The revocation still goes out when the Console loads another page right after.
      keepalive: true,
      method: "POST",
    })
    return response.ok
  }
  catch {
    return false
  }
}

/** Runs one callback at a time per name, in every tab of the origin, such as the Web Locks API. */
export type ConsoleOAuthLock = <T>(name: string, run: () => Promise<T>) => Promise<T>

/** Serializes grant persistence with sign-out and Forget, without waiting for a token request. */
export const consoleOAuthGrantLockName = (projectUrl: string): string => `vitehub-console:oauth:${projectUrl}:grant`

/** The Web Locks API of the browser, or `undefined` where it does not exist. */
export function browserOAuthLock(): ConsoleOAuthLock | undefined {
  const navigator: unknown = Reflect.get(globalThis, "navigator")
  const locks: unknown = field(navigator, "locks")
  const request: unknown = field(locks, "request")
  if (!(request instanceof Function)) return undefined
  return <T>(name: string, run: () => Promise<T>): Promise<T> => Reflect.apply(request, locks, [name, run])
}

/**
 * A lock across tabs for browsers without Web Locks: a lease in `localStorage`. A tab writes the lease, waits a moment,
 * and runs only when the lease is still its own. Other tabs wait until the lease ends, then run and read the tokens
 * that the first tab saved. The owner renews its lease while the callback runs. Without renewal, the lease ends after
 * `ttl` milliseconds, so a closed tab does not block the others.
 */
export function storageOAuthLock(
  storage: ConsoleProjectStorage,
  options: { now?: () => number, sleep?: (milliseconds: number) => Promise<void>, ttl?: number } = {},
): ConsoleOAuthLock {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) }))
  const ttl = options.ttl ?? 10_000
  const read = (key: string): { owner?: string, until: number } => {
    try {
      const value: unknown = JSON.parse(storage.getItem(key) || "null")
      const owner = text(field(value, "owner"))
      const until: unknown = field(value, "until")
      return { ...(owner ? { owner } : {}), until: Number.isFinite(until) ? Number(until) : 0 }
    }
    catch {
      return { until: 0 }
    }
  }
  return async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const key = `${name}:lease`
    const owner = createConsoleOAuthState()
    for (;;) {
      if (read(key).until <= now()) {
        storage.setItem(key, JSON.stringify({ owner, until: now() + ttl }))
        // Two tabs can write at the same time. The last write wins, and only its tab runs.
        await sleep(50)
        if (read(key).owner === owner) break
      }
      await sleep(100)
    }
    const renew = setInterval(() => {
      if (read(key).owner === owner) storage.setItem(key, JSON.stringify({ owner, until: now() + ttl }))
    }, ttl / 3)
    try {
      return await run()
    }
    finally {
      clearInterval(renew)
      if (read(key).owner === owner) storage.setItem(key, "")
    }
  }
}

/** Gives each request a fresh access token, and refreshes at most once at a time per project. */
export interface ConsoleOAuthRefresher {
  /**
   * The access token to send to a project. It refreshes first when the token expires within a minute, or when the
   * project refused `rejected`. Concurrent calls wait for the same refresh. `undefined` means the project has no tokens,
   * or the refresh failed; `read()` then tells whether the tokens are gone and the person must sign in again.
   */
  accessToken(projectUrl: string, options?: { rejected?: string }): Promise<string | undefined>
}

export function createConsoleOAuthRefresher(options: {
  read: (projectUrl: string) => ConsoleOAuthTokens | undefined
  /** Save the new tokens of a project, or `null` to remove them after the server refused the refresh token. */
  write: (projectUrl: string, tokens: ConsoleOAuthTokens | null) => void
  fetch: ConsoleOAuthFetch
  now?: () => number
  /** A lock across tabs, so two tabs do not both use one refresh token that the server rotates. */
  lock?: ConsoleOAuthLock
}): ConsoleOAuthRefresher {
  const now = options.now ?? Date.now
  const flights = new Map<string, Promise<string | undefined>>()
  const usable = (tokens: ConsoleOAuthTokens, rejected: string | undefined): boolean =>
    tokens.accessToken !== rejected && tokens.expiresAt - now() > consoleOAuthRefreshMargin
  const refresh = async (projectUrl: string, rejected: string | undefined): Promise<string | undefined> => {
    // Another tab can have refreshed while this one waited for the lock.
    const latest = options.read(projectUrl)
    if (!latest) return undefined
    if (usable(latest, rejected)) return latest.accessToken
    const result = await refreshConsoleOAuthTokens(latest, { fetch: options.fetch, now })
    let discarded: ConsoleOAuthTokens | undefined
    const persist = async (): Promise<string | undefined> => {
      const current = options.read(projectUrl)
      // This check and the write share the removal lock, including the store's read-modify-write operations.
      if (!current) {
        if (result.kind === "tokens") discarded = result.tokens
        return undefined
      }
      // A later sign-in or another tab's rotation owns the stored grant now.
      if (current.refreshToken !== latest.refreshToken || current.accessToken !== latest.accessToken) {
        if (result.kind === "tokens" && result.tokens.refreshToken !== current.refreshToken) discarded = result.tokens
        return current.accessToken === rejected ? undefined : current.accessToken
      }
      if (result.kind === "tokens") {
        options.write(projectUrl, result.tokens)
        return result.tokens.accessToken
      }
      if (result.kind === "rejected" && !result.retryable) {
        options.write(projectUrl, null)
        return undefined
      }
      // Temporary request failure: keep the tokens, so the Console works again when the project answers.
      return latest.accessToken === rejected ? undefined : latest.accessToken
    }
    const token = await (options.lock ? options.lock(consoleOAuthGrantLockName(projectUrl), persist) : persist())
    // Keep network work outside the grant lock so a slow endpoint cannot delay local sign-out.
    if (discarded) await revokeConsoleOAuthTokens(discarded, { fetch: options.fetch })
    return token
  }
  return {
    accessToken(projectUrl: string, { rejected }: { rejected?: string } = {}): Promise<string | undefined> {
      const tokens = options.read(projectUrl)
      if (!tokens) return Promise.resolve(undefined)
      if (usable(tokens, rejected)) return Promise.resolve(tokens.accessToken)
      const running = flights.get(projectUrl)
      if (running) return running
      const run = () => refresh(projectUrl, rejected)
      const flight = (options.lock ? options.lock(`vitehub-console:oauth:${projectUrl}`, run) : run())
        .finally(() => flights.delete(projectUrl))
      flights.set(projectUrl, flight)
      return flight
    },
  }
}

/**
 * The query of the `/oauth/callback` page below `base`, or `undefined` on another page. It replaces the address with the
 * Console home at once, so the code does not stay in the history, and a reload does not try the same code again.
 */
export function takeConsoleOAuthCallback(page: ConsoleLinkPage, base: string): string | undefined {
  const { pathname, search } = page.location
  const home = base.replace(/\/+$/, "")
  if (pathname.replace(/\/+$/, "") !== `${home}${consoleOAuthCallbackPath}`) return undefined
  page.history.replaceState(null, "", `${home}/`)
  return search
}
