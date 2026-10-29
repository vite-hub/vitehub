import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js"

import { consoleMountBase } from "../console-route.ts"
import { consoleMcpCallbackPath } from "../mcp-client.ts"
import { readConsoleOperationUser } from "./access.ts"
import { consoleMcpRecords, resetConsoleMcpRecords } from "./mcp-client-store.ts"
import { consoleRequestError, consoleRequestURL } from "./request.ts"

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { ConsoleMcpCandidate, ConsoleMcpConnection, ConsoleMcpConnectResult, ConsoleMcpIdentity, ConsoleMcpListKind, ConsoleMcpOutcome, ConsoleMcpOverview, ConsoleMcpPage, ConsoleMcpServerInfo } from "../mcp-client.ts"
import type { ConsoleAccess } from "./access.ts"
import type { PendingAuthorization, StoredConnection } from "./mcp-client-store.ts"

/** The Console request that runs an MCP operation: who calls, and from which page. */
export interface ConsoleMcpCaller {
  access: ConsoleAccess
  request?: Request
}

/** The MCP servers that each origin announced, for a minute. */
const discovered = new Map<string, { at: number, servers: ConsoleMcpCandidate[] }>()

const pendingLifetimeMs = 10 * 60_000
const discoveryLifetimeMs = 60_000
const requestTimeoutMs = 30_000
const callTimeoutMs = 120_000
const maximumConnections = 20
const clientInfo = { name: "vitehub-console", title: "ViteHub Console", version: "1.0.0" }

/** Every person keeps their own connections. A Console without accounts shares one owner per access mode. */
async function ownerOf(caller: ConsoleMcpCaller): Promise<string> {
  const user = await readConsoleOperationUser(caller.access)
  if (user?.id) return `user:${user.id}`
  if (caller.access.mode === "auth") throw consoleRequestError(403, "The Console session has no user id, so the Console cannot keep MCP connections for it.", "CONSOLE_MANAGER_REQUIRED")
  const email = caller.access.mode === "cloudflare-access" ? caller.request?.headers.get("cf-access-authenticated-user-email") : undefined
  return email ? `cloudflare-access:${email}` : caller.access.mode
}

/** The origin and Console mount that the browser sees, from the RPC request. */
function consolePage(caller: ConsoleMcpCaller): { mount: string, origin: string } {
  if (!caller.request) throw consoleRequestError(400, "MCP connections need the Console page that calls them.")
  const url = consoleRequestURL({ req: caller.request })
  return { mount: consoleMountBase(url.pathname), origin: url.origin }
}

/** ViteHub MCP, the MCP server of the Console, under the Console mount. */
const viteHubMcpPath = "/_vitehub/mcp"
/** The request headers that carry a Console session: an app session cookie, a bearer token, or a Cloudflare Access token. */
const sessionHeaders = ["authorization", "cf-access-jwt-assertion", "cookie"] as const

function viteHubMcpUrl(caller: ConsoleMcpCaller): string {
  const { mount, origin } = consolePage(caller)
  return `${origin}${mount}${viteHubMcpPath}`
}

/**
 * The Console session of this request, for a `console` connection. It goes only to ViteHub MCP on the origin and mount
 * of this request, and the Console keeps none of it.
 */
function consoleSession(caller: ConsoleMcpCaller, connection: StoredConnection): Record<string, string> {
  if (connection.auth !== "console" || connection.url !== viteHubMcpUrl(caller)) return {}
  const headers: Record<string, string> = {}
  for (const name of sessionHeaders) {
    const value = caller.request?.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Resolve a URL or a path such as `/mcp` against the Console origin. Plain HTTP works only on this origin and on loopback hosts. */
function serverUrl(value: string, origin: string): URL {
  let url: URL
  try {
    url = new URL(value.trim(), origin)
  }
  catch {
    throw consoleRequestError(400, "Enter the URL of an MCP endpoint, such as https://example.com/mcp, or a path on this app, such as /mcp.")
  }
  const loopback = loopbackHosts.has(url.hostname) || url.hostname.endsWith(".localhost")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.origin === origin || loopback))) {
    throw consoleRequestError(400, "Use an HTTPS URL. Plain HTTP works only for this app and for localhost.")
  }
  if (url.username || url.password || url.hash) throw consoleRequestError(400, "The MCP URL cannot contain credentials or a fragment.")
  return url
}

function withTimeout(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  }
}

function randomId(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The claims of a JWT, without checking its signature. The token came straight from the token endpoint. */
function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1]
  if (!payload) return undefined
  try {
    const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"))
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))))
    return isRecord(claims) ? claims : undefined
  }
  catch {
    return undefined
  }
}

function identityFrom(claims: Record<string, unknown> | undefined): ConsoleMcpIdentity | undefined {
  if (!claims) return undefined
  const identity: ConsoleMcpIdentity = {}
  const subject = text(claims.sub)
  const name = text(claims.name) ?? text(claims.preferred_username)
  const email = text(claims.email)
  const picture = text(claims.picture)
  if (subject) identity.subject = subject
  if (name) identity.name = name
  if (email) identity.email = email
  if (picture?.startsWith("https://")) identity.picture = picture
  return Object.keys(identity).length ? identity : undefined
}

/** Who the grant belongs to: the ID token, then the userinfo endpoint, then the access token. */
async function readIdentity(connection: StoredConnection): Promise<ConsoleMcpIdentity | undefined> {
  const tokens = connection.oauth?.tokens
  if (!tokens) return undefined
  const fromIdToken = identityFrom(jwtClaims(tokens.id_token))
  if (fromIdToken?.name || fromIdToken?.email) return fromIdToken
  const userinfo = text(connection.oauth?.discovery?.authorizationServerMetadata?.userinfo_endpoint)
  if (userinfo) {
    try {
      const response = await withTimeout(requestTimeoutMs)(userinfo, { headers: { accept: "application/json", authorization: `Bearer ${tokens.access_token}` } })
      const claims: unknown = response.ok ? await response.json() : undefined
      const identity = identityFrom(isRecord(claims) ? claims : undefined)
      if (identity) return { ...fromIdToken, ...identity }
    }
    catch {
      // Some servers accept only tokens that name them as the audience. The tokens still name the subject.
    }
  }
  return fromIdToken ?? identityFrom(jwtClaims(tokens.access_token))
}

function clientKey(connection: StoredConnection): string {
  const oauth = connection.oauth!
  return `${oauth.discovery?.authorizationServerUrl ?? new URL(connection.url).origin}\n${oauth.redirectUrl}`
}

/**
 * The OAuth client of one connection for the MCP SDK. Everything it saves stays on the server: the registration, the
 * PKCE verifier, the discovery result, and the tokens. The operation saves the connection when it ends.
 * `redirectToAuthorization()` only records the URL; the Console page opens it.
 */
function oauthProvider(connection: StoredConnection, onAuthorize?: () => void): OAuthClientProvider {
  const oauth = connection.oauth!
  const pending = (): PendingAuthorization => oauth.pending ??= { expiresAt: Date.now() + pendingLifetimeMs, state: randomId() }
  const metadata: OAuthClientMetadata = {
    client_name: "ViteHub Console",
    client_uri: "https://vitehub.dev/docs/development/console",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [oauth.redirectUrl],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }
  return {
    get clientMetadata() {
      return metadata
    },
    get redirectUrl() {
      return oauth.redirectUrl
    },
    clientInformation: async () => (await consoleMcpRecords()).client(clientKey(connection)),
    codeVerifier: () => {
      const verifier = oauth.pending?.verifier
      if (!verifier) throw consoleRequestError(409, "This sign-in has no PKCE verifier. Start it again.", "CONSOLE_MCP_AUTHORIZATION_FAILED")
      return verifier
    },
    discoveryState: () => {
      // The SDK reads the discovery state first whenever it authorizes.
      onAuthorize?.()
      return oauth.discovery
    },
    invalidateCredentials: async (credentials) => {
      if (credentials === "all" || credentials === "client") await (await consoleMcpRecords()).removeClient(clientKey(connection))
      if (credentials === "all" || credentials === "tokens") oauth.tokens = undefined
      if (credentials === "all" || credentials === "verifier") delete pending().verifier
      if (credentials === "all" || credentials === "discovery") oauth.discovery = undefined
    },
    redirectToAuthorization: (url) => {
      const current = pending()
      if (current.prompt) url.searchParams.set("prompt", [current.prompt, ...(url.searchParams.get("prompt")?.split(" ") ?? [])].filter((value, index, all) => all.indexOf(value) === index).join(" "))
      current.url = url.href
    },
    saveClientInformation: async (information) => {
      await (await consoleMcpRecords()).saveClient(clientKey(connection), information)
    },
    saveCodeVerifier: (verifier) => {
      pending().verifier = verifier
    },
    saveDiscoveryState: (state) => {
      oauth.discovery = state
    },
    saveTokens: (tokens) => {
      oauth.tokens = tokens
      oauth.receivedAt = Date.now()
    },
    state: () => pending().state,
    tokens: () => oauth.tokens,
  }
}

function serverInfo(client: Client, protocolVersion: string | undefined): ConsoleMcpServerInfo | undefined {
  const version = client.getServerVersion()
  if (!version) return undefined
  const capabilities = client.getServerCapabilities() ?? {}
  const details: Record<string, unknown> = version
  const icons = Array.isArray(details.icons) ? details.icons : []
  const icon = icons.map(entry => isRecord(entry) ? text(entry.src) : undefined).find(source => source?.startsWith("https://") || source?.startsWith("http://") || source?.startsWith("data:image/"))
  const info: ConsoleMcpServerInfo = {
    capabilities: {
      completions: Boolean(capabilities.completions),
      logging: Boolean(capabilities.logging),
      prompts: Boolean(capabilities.prompts),
      resources: Boolean(capabilities.resources),
      tools: Boolean(capabilities.tools),
    },
    name: version.name,
  }
  const optional = { description: text(details.description), icon, instructions: text(client.getInstructions()), protocolVersion, title: text(version.title), version: text(version.version), websiteUrl: text(details.websiteUrl) }
  for (const [key, value] of Object.entries(optional)) if (value) Object.assign(info, { [key]: value })
  return info
}

/** What a `401` asked for in `WWW-Authenticate`: where its resource metadata is, and which scope. */
type Challenge = ReturnType<typeof extractWWWAuthenticateParams>

class SignedOutError extends Error {
  constructor(message: string, readonly challenge?: Challenge) {
    super(message)
  }
}

/**
 * Run `run` with an MCP client of the connection. The client reuses the MCP session of the connection when the server
 * gave one, and starts a new session when the server forgot it. A grant that the server rejects marks the connection
 * signed out.
 */
async function withClient<T>(caller: ConsoleMcpCaller, connection: StoredConnection, run: (client: Client) => Promise<T>, options: { fresh?: boolean, timeoutMs?: number } = {}): Promise<T> {
  let authorizing = false
  let challenge: Challenge | undefined
  const fetchWithTimeout = withTimeout(options.timeoutMs ?? requestTimeoutMs)
  const headers = { ...consoleSession(caller, connection), ...(connection.bearer ? { authorization: `Bearer ${connection.bearer}` } : {}) }
  const attempt = async (sessionId: string | undefined) => {
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      ...(connection.auth === "oauth" ? { authProvider: oauthProvider(connection, () => { authorizing = true }) } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: async (input, init) => {
        const response = await fetchWithTimeout(input, init)
        if (response.status === 401) challenge = extractWWWAuthenticateParams(response)
        return response
      },
      ...(sessionId ? { sessionId } : {}),
    })
    if (sessionId && connection.protocolVersion) transport.setProtocolVersion(connection.protocolVersion)
    // The Console shows results as the server sent them, so it does not check them against output schemas.
    const client = new Client(clientInfo, { capabilities: {}, jsonSchemaValidator: { getValidator: () => input => ({ data: input as never, errorMessage: undefined, valid: true }) } })
    try {
      await client.connect(transport, { timeout: requestTimeoutMs })
      if (!sessionId) {
        connection.protocolVersion = transport.protocolVersion
        connection.server = serverInfo(client, transport.protocolVersion) ?? connection.server
      }
      connection.sessionId = transport.sessionId
      const value = await run(client)
      connection.status = "connected"
      delete connection.error
      connection.usedAt = Date.now()
      return value
    }
    finally {
      await transport.close().catch(() => {})
    }
  }
  try {
    const sessionId = options.fresh ? undefined : connection.sessionId
    try {
      return await attempt(sessionId)
    }
    catch (error) {
      // A server forgets a session when it restarts. It answers 404 and expects a new initialize.
      if (!sessionId || !(error instanceof StreamableHTTPError) || error.code !== 404) throw error
      delete connection.sessionId
      return await attempt(undefined)
    }
  }
  catch (error) {
    if (error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401)) {
      // A request leaves no sign-in behind. Connect and reconnect start one with `startAuthorization()`.
      if (connection.oauth?.pending) delete connection.oauth.pending
      connection.status = "signed-out"
      connection.error = { bearer: "The server rejected this token.", console: "ViteHub MCP did not accept your Console session.", none: "The server asks for credentials.", oauth: "The server rejected the grant. Sign in again." }[connection.auth]
      delete connection.sessionId
      throw new SignedOutError(connection.error, challenge)
    }
    if (error instanceof McpError) throw error
    connection.status = "failed"
    if (authorizing) {
      if (connection.oauth?.pending && !connection.oauth.pending.url) delete connection.oauth.pending
      connection.error = `OAuth sign-in could not start: ${failureMessage(error)}`
      throw consoleRequestError(502, connection.error, "CONSOLE_MCP_AUTHORIZATION_FAILED")
    }
    connection.error = failureMessage(error)
    throw consoleRequestError(502, connection.error, "CONSOLE_MCP_UNREACHABLE")
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof StreamableHTTPError) return error.code === 404 ? "The URL does not serve MCP. Check the endpoint path, such as /mcp." : `The server answered HTTP ${error.code ?? "error"}.`
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "The server did not answer in time."
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) return "The server cannot be reached."
  return message.slice(0, 300) || "The MCP handshake failed."
}

function describe(connection: StoredConnection): ConsoleMcpConnection {
  const tokens = connection.oauth?.tokens
  const described: ConsoleMcpConnection = {
    auth: connection.auth,
    createdAt: new Date(connection.createdAt).toISOString(),
    id: connection.id,
    label: connection.label,
    sameOrigin: connection.sameOrigin,
    status: connection.status,
    url: connection.url,
  }
  if (connection.error) described.error = connection.error
  if (connection.identity) described.identity = connection.identity
  if (connection.server) described.server = connection.server
  if (connection.sessionId) described.session = connection.sessionId.slice(-8)
  if (connection.usedAt) described.usedAt = new Date(connection.usedAt).toISOString()
  if (connection.bearer) described.grant = { hint: connection.bearer.slice(-4), refreshable: false, scopes: [] }
  if (tokens) {
    const issuer = text(connection.oauth?.discovery?.authorizationServerMetadata?.issuer) ?? text(connection.oauth?.discovery?.authorizationServerUrl)
    described.grant = {
      ...(tokens.expires_in && connection.oauth?.receivedAt ? { expiresAt: new Date(connection.oauth.receivedAt + tokens.expires_in * 1000).toISOString() } : {}),
      ...(issuer ? { issuer } : {}),
      refreshable: Boolean(tokens.refresh_token),
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? [],
    }
  }
  return described
}

/** End a sign-in that did not finish in time. Returns whether the connection changed. */
function prune(connection: StoredConnection, now = Date.now()): boolean {
  const pending = connection.oauth?.pending
  if (!pending || pending.expiresAt > now) return false
  delete connection.oauth!.pending
  if (connection.status === "authorizing") {
    connection.status = connection.oauth?.tokens ? "signed-out" : "failed"
    connection.error = "The sign-in did not finish in time. Start it again."
  }
  return true
}

async function save(connection: StoredConnection): Promise<void> {
  await (await consoleMcpRecords()).save(connection)
}

/** The connections of one person, oldest first. */
async function owned(owner: string): Promise<StoredConnection[]> {
  const connections = await (await consoleMcpRecords()).connections(owner)
  await Promise.all(connections.filter(connection => prune(connection)).map(save))
  return connections.sort((left, right) => left.createdAt - right.createdAt)
}

async function connectionOf(caller: ConsoleMcpCaller, id: string): Promise<StoredConnection> {
  const records = await consoleMcpRecords()
  // Another person's connection reads as missing, so ids do not reveal who has which server.
  const connection = await records.connection(await ownerOf(caller), id)
  if (!connection) throw consoleRequestError(404, records.durable ? "This MCP connection does not exist. It was disconnected." : "This MCP connection does not exist. It ends when the server restarts.")
  if (prune(connection)) await save(connection)
  return connection
}

/** Run `change` on a connection of the caller, then keep what it changed, also when it fails. */
async function withConnection<T>(caller: ConsoleMcpCaller, id: string, change: (connection: StoredConnection) => Promise<T>): Promise<T> {
  const connection = await connectionOf(caller, id)
  try {
    return await change(connection)
  }
  finally {
    await save(connection)
  }
}

/** MCP servers that the app announces on its own origin, from RFC 9728 protected resource metadata. */
async function discoverAppServers(origin: string): Promise<ConsoleMcpCandidate[]> {
  const cached = discovered.get(origin)
  if (cached && Date.now() - cached.at < discoveryLifetimeMs) return cached.servers
  const servers: ConsoleMcpCandidate[] = []
  try {
    const response = await withTimeout(5_000)(`${origin}/.well-known/oauth-protected-resource`, { headers: { accept: "application/json" } })
    const metadata: unknown = response.ok ? await response.json() : undefined
    if (isRecord(metadata)) {
      const resource = text(metadata.resource)
      const url = resource && URL.canParse(resource) ? new URL(resource) : undefined
      if (url && url.origin === origin) {
        // A resource without a path names the whole origin. MCP servers usually serve it at /mcp.
        const endpoint = url.pathname === "/" ? new URL("/mcp", origin) : url
        const servers_ = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : []
        const authorizationServer = text(servers_[0])
        servers.push({ label: text(metadata.resource_name) ?? "This app", url: endpoint.href, ...(authorizationServer ? { authorizationServer } : {}) })
      }
    }
  }
  catch {
    // An app without the metadata has no announced server. The person can still enter a URL.
  }
  discovered.set(origin, { at: Date.now(), servers })
  return servers
}

export async function listConsoleMcp(caller: ConsoleMcpCaller, options: { sharedSession: boolean }): Promise<ConsoleMcpOverview> {
  const owner = await ownerOf(caller)
  const { origin } = consolePage(caller)
  const viteHubMcp = viteHubMcpUrl(caller)
  return {
    connections: (await owned(owner)).map(describe),
    servers: [...(await discoverAppServers(origin)).filter(server => server.url !== viteHubMcp), { auth: "console", label: "ViteHub MCP", url: viteHubMcp }],
    sharedSession: options.sharedSession,
  }
}

/**
 * The scope of a sign-in: the one that the server asked for, else the one in its resource metadata, as the MCP SDK
 * picks it. When the authorization server offers `offline_access`, the Console adds it (SEP-2207), so the server can
 * issue a refresh token.
 */
function signInScope(discovery: OAuthDiscoveryState, requested: string | undefined): string | undefined {
  const scope = requested || discovery.resourceMetadata?.scopes_supported?.join(" ")
  if (!scope || scope.split(" ").includes("offline_access") || !discovery.authorizationServerMetadata?.scopes_supported?.includes("offline_access")) return scope
  return `${scope} offline_access`
}

/**
 * Start the authorization code flow of an OAuth connection. Returns the URL that the browser opens. `challenge` is the
 * `WWW-Authenticate` of the `401` that asked for the sign-in.
 */
async function startAuthorization(connection: StoredConnection, prompt: "login" | undefined, challenge?: Challenge): Promise<string> {
  const oauth = connection.oauth!
  oauth.pending = { expiresAt: Date.now() + pendingLifetimeMs, state: randomId(), ...(prompt ? { prompt } : {}) }
  oauth.tokens = undefined
  delete connection.sessionId
  const fetchFn = withTimeout(requestTimeoutMs)
  try {
    // The Console discovers before the SDK does, because the scope depends on the authorization server metadata.
    const known = oauth.discovery?.resourceMetadataUrl
    const resourceMetadataUrl = challenge?.resourceMetadataUrl ?? (known ? new URL(known) : undefined)
    const found = await discoverOAuthServerInfo(connection.url, { fetchFn, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) })
    oauth.discovery = { ...found, ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}) }
    const scope = signInScope(oauth.discovery, challenge?.scope)
    const result = await auth(oauthProvider(connection), { fetchFn, serverUrl: connection.url, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) })
    if (result === "REDIRECT" && oauth.pending.url) {
      connection.status = "authorizing"
      delete connection.error
      return oauth.pending.url
    }
    throw new Error("The authorization server did not start a sign-in.")
  }
  catch (error) {
    delete oauth.pending
    connection.status = "failed"
    connection.error = `OAuth sign-in could not start: ${failureMessage(error)}`
    throw consoleRequestError(502, connection.error, "CONSOLE_MCP_AUTHORIZATION_FAILED")
  }
}

/**
 * Connect to an MCP server. A pasted `token` is sent as a bearer token. Without one, the Console first connects
 * without credentials; a server that answers `401` starts the MCP authorization flow, and the result names the URL
 * to open. `prompt: "login"` asks the authorization server to show its sign-in even when someone is signed in.
 */
export async function connectConsoleMcp(caller: ConsoleMcpCaller, input: { label?: string, prompt?: "login", server: string, token?: string }): Promise<ConsoleMcpConnectResult> {
  const owner = await ownerOf(caller)
  const { mount, origin } = consolePage(caller)
  const url = serverUrl(input.server, origin)
  const token = text(input.token)
  // ViteHub MCP accepts the Console session, so the Console needs no sign-in or token for it. One session is one
  // account, so connecting again opens the same connection.
  const session = !token && url.href === viteHubMcpUrl(caller)
  const mine = await owned(owner)
  const existing = session ? mine.find(candidate => candidate.auth === "console" && candidate.url === url.href) : undefined
  if (!existing && mine.length >= maximumConnections) throw consoleRequestError(409, `The Console keeps ${maximumConnections} MCP connections per person. Disconnect one first.`)
  const user = session ? await readConsoleOperationUser(caller.access) : undefined
  const identity = user ? identityFrom({ email: user.email, name: user.name, picture: user.image, sub: user.id }) : undefined
  const connection: StoredConnection = existing ?? {
    auth: token ? "bearer" : session ? "console" : "none",
    ...(token ? { bearer: token } : {}),
    createdAt: Date.now(),
    id: `mcp_${randomId(12)}`,
    ...(identity ? { identity } : {}),
    label: text(input.label)?.slice(0, 80) ?? (session ? identity?.name ?? identity?.email ?? "Console session" : url.host + (url.pathname === "/" ? "" : url.pathname)),
    labelled: Boolean(text(input.label)),
    owner,
    sameOrigin: url.origin === origin,
    status: "failed",
    url: url.href,
  }
  try {
    await withClient(caller, connection, async () => {}, { fresh: true })
    await save(connection)
    return { connection: describe(connection) }
  }
  catch (error) {
    if (!(error instanceof SignedOutError)) throw error
    if (connection.auth !== "none") throw consoleRequestError(409, error.message, "CONSOLE_MCP_SIGNED_OUT")
    // Without a token, a server that asks for credentials gets the MCP authorization flow.
    connection.auth = "oauth"
    connection.oauth = { redirectUrl: `${origin}${mount}${consoleMcpCallbackPath}` }
    try {
      return { authorizationUrl: await startAuthorization(connection, input.prompt, error.challenge), connection: describe(connection) }
    }
    finally {
      await save(connection)
    }
  }
}

interface CompleteInput {
  code?: string
  error?: string
  errorDescription?: string
  iss?: string
  state: string
}

/** Finish the sign-in that the authorization server redirected back from. */
export async function completeConsoleMcp(caller: ConsoleMcpCaller, input: CompleteInput): Promise<ConsoleMcpConnection> {
  const owner = await ownerOf(caller)
  const connection = (await owned(owner)).find(candidate => candidate.oauth?.pending?.state === input.state)
  // A state of another person, an expired one, or one used before reads the same: the sign-in is not known.
  if (!connection?.oauth?.pending) throw consoleRequestError(404, "This sign-in is not known. It expired, finished already, or was started by someone else. Start it again.", "CONSOLE_MCP_AUTHORIZATION_FAILED")
  try {
    return await finishSignIn(caller, connection, input)
  }
  finally {
    await save(connection)
  }
}

async function finishSignIn(caller: ConsoleMcpCaller, connection: StoredConnection, input: CompleteInput): Promise<ConsoleMcpConnection> {
  const oauth = connection.oauth!
  const pending = oauth.pending!
  if (input.error || !input.code) {
    delete oauth.pending
    connection.status = oauth.tokens ? "signed-out" : "failed"
    connection.error = input.error === "access_denied" ? "The sign-in was denied." : `The authorization server returned ${text(input.error) ?? "no code"}${input.errorDescription ? `: ${input.errorDescription.slice(0, 200)}` : "."}`
    throw consoleRequestError(400, connection.error, "CONSOLE_MCP_AUTHORIZATION_FAILED")
  }
  // RFC 9207: a server that names itself in the response must be the one this sign-in started at.
  const issuer = text(oauth.discovery?.authorizationServerMetadata?.issuer)
  if (input.iss && issuer && input.iss !== issuer) {
    delete oauth.pending
    connection.status = "failed"
    connection.error = "The sign-in came back from another authorization server."
    throw consoleRequestError(400, connection.error, "CONSOLE_MCP_AUTHORIZATION_FAILED")
  }
  try {
    const result = await auth(oauthProvider(connection), { authorizationCode: input.code, fetchFn: withTimeout(requestTimeoutMs), serverUrl: connection.url })
    if (result !== "AUTHORIZED") throw new Error("The authorization server did not issue a token.")
  }
  catch (error) {
    delete oauth.pending
    connection.status = "failed"
    connection.error = `The token exchange failed: ${failureMessage(error)}`
    throw consoleRequestError(502, connection.error, "CONSOLE_MCP_AUTHORIZATION_FAILED")
  }
  if (pending === oauth.pending) delete oauth.pending
  connection.identity = await readIdentity(connection)
  if (!connection.labelled) connection.label = connection.identity?.name ?? connection.identity?.email ?? connection.label
  try {
    await withClient(caller, connection, async () => {}, { fresh: true })
  }
  catch (error) {
    if (error instanceof SignedOutError) throw consoleRequestError(409, error.message, "CONSOLE_MCP_SIGNED_OUT")
    throw error
  }
  return describe(connection)
}

/** Sign in again, or open a new MCP session. OAuth connections return the URL to open. */
export async function reconnectConsoleMcp(caller: ConsoleMcpCaller, input: { id: string, prompt?: "login" }): Promise<ConsoleMcpConnectResult> {
  return withConnection(caller, input.id, async (connection) => {
    if (connection.auth === "oauth" && (input.prompt || connection.status === "signed-out" || connection.status === "authorizing" || !connection.oauth?.tokens)) {
      return { authorizationUrl: await startAuthorization(connection, input.prompt), connection: describe(connection) }
    }
    try {
      await withClient(caller, connection, async () => {}, { fresh: true })
    }
    catch (error) {
      if (!(error instanceof SignedOutError)) throw error
      if (connection.auth !== "oauth") throw consoleRequestError(409, error.message, "CONSOLE_MCP_SIGNED_OUT")
      return { authorizationUrl: await startAuthorization(connection, input.prompt, error.challenge), connection: describe(connection) }
    }
    return { connection: describe(connection) }
  })
}

/** RFC 7009: ask the authorization server to forget a token. Returns whether it confirmed. */
async function revoke(connection: StoredConnection): Promise<boolean> {
  const oauth = connection.oauth
  // RFC 8414 metadata names it. The OpenID Connect metadata type of the SDK does not, so read it as a plain field.
  const metadata: Record<string, unknown> = { ...oauth?.discovery?.authorizationServerMetadata }
  const endpoint = text(metadata.revocation_endpoint)
  const client = oauth ? await (await consoleMcpRecords()).client(clientKey(connection)) : undefined
  if (!oauth?.tokens || !endpoint || !client) return false
  const tokens = [[oauth.tokens.refresh_token, "refresh_token"], [oauth.tokens.access_token, "access_token"]] as const
  let revoked = false
  for (const [token, hint] of tokens) {
    if (!token) continue
    const body = new URLSearchParams({ client_id: client.client_id, token, token_type_hint: hint })
    if (client.client_secret) body.set("client_secret", client.client_secret)
    try {
      const response = await withTimeout(requestTimeoutMs)(endpoint, { body, headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST" })
      revoked ||= response.ok
    }
    catch {
      // The token still expires on its own. The Console forgets it either way.
    }
  }
  return revoked
}

/** End the MCP session, revoke the OAuth tokens, and forget the connection. */
export async function disconnectConsoleMcp(caller: ConsoleMcpCaller, input: { id: string }): Promise<{ revoked: boolean, sessionEnded: boolean }> {
  const connection = await connectionOf(caller, input.id)
  await (await consoleMcpRecords()).remove(connection)
  let sessionEnded = false
  if (connection.sessionId) {
    try {
      const headers: Record<string, string> = { "mcp-session-id": connection.sessionId }
      const bearer = connection.bearer ?? connection.oauth?.tokens?.access_token
      if (bearer) headers.authorization = `Bearer ${bearer}`
      if (connection.protocolVersion) headers["mcp-protocol-version"] = connection.protocolVersion
      const response = await withTimeout(requestTimeoutMs)(connection.url, { headers, method: "DELETE" })
      sessionEnded = response.ok
    }
    catch {
      // The server ends idle sessions on its own.
    }
  }
  return { revoked: await revoke(connection), sessionEnded }
}

const listMethods: Readonly<Record<ConsoleMcpListKind, { field: string, method: "prompts/list" | "resources/list" | "resources/templates/list" | "tools/list" }>> = {
  "prompts": { field: "prompts", method: "prompts/list" },
  "resource-templates": { field: "resourceTemplates", method: "resources/templates/list" },
  "resources": { field: "resources", method: "resources/list" },
  "tools": { field: "tools", method: "tools/list" },
}

function signedOut(error: unknown): never {
  if (error instanceof SignedOutError) throw consoleRequestError(409, error.message, "CONSOLE_MCP_SIGNED_OUT")
  throw error
}

/** One page of tools, resources, resource templates, or prompts. */
export async function listConsoleMcpItems(caller: ConsoleMcpCaller, input: { cursor?: string, id: string, kind: ConsoleMcpListKind }): Promise<ConsoleMcpPage & { connection: ConsoleMcpConnection }> {
  return withConnection(caller, input.id, async (connection) => {
    const { field, method } = listMethods[input.kind]
    try {
      const result = await withClient(caller, connection, client => client.request({ method, params: input.cursor ? { cursor: input.cursor } : {} }, ResultSchema, { timeout: requestTimeoutMs }))
      const values = Reflect.get(result, field)
      const items = Array.isArray(values) ? values.filter(isRecord) : []
      const nextCursor = text(Reflect.get(result, "nextCursor"))
      return { connection: describe(connection), items, ...(nextCursor ? { nextCursor } : {}) }
    }
    catch (error) {
      // A server without this capability answers "method not found". It has none of these items.
      if (error instanceof McpError && error.code === -32601) return { connection: describe(connection), items: [] }
      return signedOut(error)
    }
  })
}

/** Send one request and return the result or the JSON-RPC error of the server, with the time it took. */
async function outcome(caller: ConsoleMcpCaller, id: string, request: { method: "prompts/get" | "resources/read" | "tools/call", params: Record<string, unknown> }, timeoutMs: number): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return withConnection(caller, id, async (connection) => {
    const startedAt = performance.now()
    try {
      const result = await withClient(caller, connection, client => client.request(request, ResultSchema, { maxTotalTimeout: timeoutMs, timeout: timeoutMs }), { timeoutMs })
      return { connection: describe(connection), durationMs: Math.round(performance.now() - startedAt), result }
    }
    catch (error) {
      if (!(error instanceof McpError)) return signedOut(error)
      connection.status = "connected"
      return {
        connection: describe(connection),
        durationMs: Math.round(performance.now() - startedAt),
        error: { code: error.code, message: error.message.replace(/^(?:MCP error -?\d+: )+/, ""), ...(error.data === undefined ? {} : { data: error.data }) },
      }
    }
  })
}

export function callConsoleMcpTool(caller: ConsoleMcpCaller, input: { arguments?: Record<string, unknown>, id: string, tool: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(caller, input.id, { method: "tools/call", params: { arguments: input.arguments ?? {}, name: input.tool } }, callTimeoutMs)
}

export function readConsoleMcpResource(caller: ConsoleMcpCaller, input: { id: string, uri: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(caller, input.id, { method: "resources/read", params: { uri: input.uri } }, requestTimeoutMs)
}

export function getConsoleMcpPrompt(caller: ConsoleMcpCaller, input: { arguments?: Record<string, string>, id: string, name: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(caller, input.id, { method: "prompts/get", params: { arguments: input.arguments ?? {}, name: input.name } }, requestTimeoutMs)
}

/** Forget every connection of this process. Tests use it. */
export function resetConsoleMcp(): void {
  resetConsoleMcpRecords()
  discovered.clear()
}
