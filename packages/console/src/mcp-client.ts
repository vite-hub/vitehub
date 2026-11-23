import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js"

import { allowPrivateVariable, isPrivateHost } from "./project-url.ts"

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { ConsoleMcpRecords, PendingAuthorization, StoredConnection } from "./mcp-client-records.ts"
import type { ConsoleMcpCandidate, ConsoleMcpConnection, ConsoleMcpConnectResult, ConsoleMcpIdentity, ConsoleMcpListKind, ConsoleMcpOutcome, ConsoleMcpOverview, ConsoleMcpPage, ConsoleMcpServerInfo } from "./mcp-client-types.ts"

type ConsoleMcpErrorCode =
  | "CONSOLE_CONFLICT"
  | "CONSOLE_MCP_AUTHORIZATION_FAILED"
  | "CONSOLE_MCP_SIGNED_OUT"
  | "CONSOLE_MCP_UNREACHABLE"
  | "CONSOLE_NOT_FOUND"
  | "CONSOLE_REQUEST_INVALID"

/** A failure of an MCP client operation, with the HTTP status and the code that the Console page reads. */
export class ConsoleMcpError extends Error {
  readonly status: number
  readonly code: ConsoleMcpErrorCode
  challenge?: ReturnType<typeof extractWWWAuthenticateParams>

  constructor(status: number, code: ConsoleMcpErrorCode, message: string) {
    super(message)
    this.name = "ConsoleMcpError"
    this.status = status
    this.code = code
  }
}

/** Who calls, on which project, and where the records live. The Console route builds it for each request. */
export interface ConsoleMcpScope {
  userId: string
  projectId: string
  /** The origin of the project's app. A path such as `/mcp` resolves against it, and its servers are "this app". */
  appOrigin: string
  /** Where authorization servers send the browser back, `<Console origin>/mcp-client/callback`. */
  redirectUrl: string
  /** Allow private and loopback hosts, and plain HTTP to them, as `VITEHUB_CONSOLE_ALLOW_PRIVATE=true` does. */
  allowPrivate: boolean
  records: ConsoleMcpRecords
}

interface UrlPolicy {
  allowPrivate: boolean
  appOrigin: string
}

interface ConnectionRuntime {
  clientOperation?: Promise<void>
  closing?: boolean
  connection?: StoredConnection
  operation?: Promise<void>
}

const discovered = new Map<string, { at: number, servers: ConsoleMcpCandidate[] }>()
const connectionRuntimes = new Map<string, ConnectionRuntime>()
const completingAuthorizations = new Set<string>()

const pendingLifetimeMs = 10 * 60_000
const discoveryLifetimeMs = 60_000
const requestTimeoutMs = 30_000
const callTimeoutMs = 120_000
const maximumConnections = 20
const clientInfo = { name: "vitehub-console", title: "ViteHub Console", version: "1.0.0" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value)
}

function consoleMcpServerUrl(value: string, policy: UrlPolicy): URL {
  let url: URL
  try {
    url = new URL(value.trim(), policy.appOrigin)
  }
  catch {
    throw new ConsoleMcpError(400, "CONSOLE_REQUEST_INVALID", "Enter the URL of an MCP endpoint, such as https://example.com/mcp, or a path on the app, such as /mcp.")
  }
  if (url.username || url.password || url.hash) throw new ConsoleMcpError(400, "CONSOLE_REQUEST_INVALID", "The MCP URL cannot contain credentials or a fragment.")
  const local = isPrivateHost(url.hostname)
  if (local && !policy.allowPrivate) {
    throw new ConsoleMcpError(400, "CONSOLE_REQUEST_INVALID", `${url.hostname} is a private address, and this Console reaches only public servers. Use a public HTTPS URL, such as a tunnel, or set ${allowPrivateVariable}=true on a Console that runs next to the server.`)
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConsoleMcpError(400, "CONSOLE_REQUEST_INVALID", "Use an HTTPS URL. Plain HTTP works only for private hosts on a Console that allows them.")
  }
  return url
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])

function withTimeout(timeoutMs: number, policy: UrlPolicy): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, init)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted()
      consoleMcpServerUrl(request.url, policy)
      const response = await fetch(request.clone(), { redirect: "manual", signal })
      const location = response.headers.get("location")
      if (!redirectStatuses.has(response.status) || location === null || request.redirect === "manual") return response
      await response.body?.cancel()
      if (request.redirect === "error") throw new ConsoleMcpError(502, "CONSOLE_MCP_UNREACHABLE", "The server returned a redirect.")
      if (redirects >= 20) throw new ConsoleMcpError(502, "CONSOLE_MCP_UNREACHABLE", "Too many redirects from the MCP or OAuth server.")
      const target = consoleMcpServerUrl(new URL(location, request.url).href, policy)
      const headers = new Headers(request.headers)
      if (target.origin !== new URL(request.url).origin) {
        for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name)
      }
      if (((response.status === 301 || response.status === 302) && request.method === "POST") || (response.status === 303 && request.method !== "GET" && request.method !== "HEAD")) {
        for (const name of ["content-encoding", "content-language", "content-location", "content-type"]) headers.delete(name)
        request = new Request(target, { headers, method: "GET", redirect: request.redirect, signal })
      }
      else {
        request = new Request(new Request(target, request), { headers })
      }
    }
  }
}

function randomId(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

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

async function readIdentity(scope: ConsoleMcpScope, connection: StoredConnection): Promise<ConsoleMcpIdentity | undefined> {
  const tokens = connection.oauth?.tokens
  if (!tokens) return undefined
  const fromIdToken = identityFrom(jwtClaims(tokens.id_token))
  if (fromIdToken?.name || fromIdToken?.email) return fromIdToken
  const userinfo = text(connection.oauth?.discovery?.authorizationServerMetadata?.userinfo_endpoint)
  if (userinfo) {
    const response = await withTimeout(requestTimeoutMs, scope)(userinfo, { headers: { accept: "application/json", authorization: `Bearer ${tokens.access_token}` } }).catch(() => undefined)
    const claims: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
    const identity = identityFrom(isRecord(claims) ? claims : undefined)
    if (identity) return { ...fromIdToken, ...identity }
  }
  return fromIdToken ?? identityFrom(jwtClaims(tokens.access_token))
}

function clientKey(connection: StoredConnection, oauth: NonNullable<StoredConnection["oauth"]>): string {
  return `${oauth.discovery?.authorizationServerUrl ?? new URL(connection.url).origin}\n${oauth.redirectUrl}\n${connection.url}`
}

function oauthProvider(scope: ConsoleMcpScope, connection: StoredConnection, onAuthorize?: () => void): OAuthClientProvider {
  const oauth = connection.oauth!
  const pending = (): PendingAuthorization => oauth.pending ??= { expiresAt: Date.now() + pendingLifetimeMs, state: randomId() }
  const metadata: OAuthClientMetadata = {
    client_name: "ViteHub Console",
    client_uri: "https://vitehub.dev/docs/console/mcp-client",
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
    clientInformation: async () => oauth.client ??= await scope.records.client(clientKey(connection, oauth)),
    codeVerifier: () => {
      const verifier = oauth.pending?.verifier
      if (!verifier) throw new ConsoleMcpError(409, "CONSOLE_MCP_AUTHORIZATION_FAILED", "This sign-in has no PKCE verifier. Start it again.")
      return verifier
    },
    discoveryState: () => {
      onAuthorize?.()
      return oauth.discovery
    },
    invalidateCredentials: async (credentials) => {
      if (credentials === "all" || credentials === "client") {
        const registered = await scope.records.client(clientKey(connection, oauth))
        if (registered?.client_id === oauth.client?.client_id && registered?.client_secret === oauth.client?.client_secret) await scope.records.removeClient(clientKey(connection, oauth))
        delete oauth.client
      }
      if (credentials === "all" || credentials === "tokens") oauth.tokens = undefined
      if (credentials === "all" || credentials === "verifier") delete pending().verifier
      if (credentials === "all" || credentials === "discovery") oauth.discovery = undefined
    },
    redirectToAuthorization: (url) => {
      const validated = consoleMcpServerUrl(url.href, scope)
      const current = pending()
      if (current.prompt) validated.searchParams.set("prompt", [current.prompt, ...(validated.searchParams.get("prompt")?.split(" ") ?? [])].filter((value, index, all) => all.indexOf(value) === index).join(" "))
      current.url = validated.href
    },
    saveClientInformation: async (information) => {
      oauth.client = information
      await scope.records.saveClient(clientKey(connection, oauth), information)
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

function isSignedOut(error: unknown): error is ConsoleMcpError {
  return error instanceof ConsoleMcpError && error.code === "CONSOLE_MCP_SIGNED_OUT"
}

interface ClientOptions { fresh?: boolean, timeoutMs?: number }

function runtimeOf(id: string): ConnectionRuntime {
  let runtime = connectionRuntimes.get(id)
  if (!runtime) connectionRuntimes.set(id, runtime = {})
  return runtime
}

function releaseRuntime(id: string, runtime: ConnectionRuntime): void {
  if (!runtime.closing && !runtime.operation && !runtime.clientOperation && connectionRuntimes.get(id) === runtime) connectionRuntimes.delete(id)
}

function assertOpen(runtime: ConnectionRuntime | undefined): void {
  if (runtime?.closing) throw new ConsoleMcpError(404, "CONSOLE_NOT_FOUND", "This MCP connection was disconnected.")
}

function serialize<T>(id: string, slot: "clientOperation" | "operation", run: (runtime: ConnectionRuntime) => Promise<T>): Promise<T> {
  const runtime = runtimeOf(id)
  const operation = (runtime[slot] ?? Promise.resolve()).then(() => run(runtime))
  const settled = operation.then(() => {}, () => {})
  runtime[slot] = settled
  void settled.then(() => {
    if (runtime[slot] === settled) delete runtime[slot]
    releaseRuntime(id, runtime)
  })
  return operation
}

function withClientOperation<T>(connection: StoredConnection, run: () => Promise<T>): Promise<T> {
  return serialize(connection.id, "clientOperation", async (runtime) => {
    assertOpen(runtime)
    runtime.connection = connection
    const value = await run()
    assertOpen(runtime)
    return value
  })
}

function withClient<T>(scope: ConsoleMcpScope, connection: StoredConnection, run: (client: Client) => Promise<T>, options: ClientOptions = {}): Promise<T> {
  return withClientOperation(connection, () => runClient(scope, connection, run, options))
}

async function runClient<T>(scope: ConsoleMcpScope, connection: StoredConnection, run: (client: Client) => Promise<T>, options: ClientOptions): Promise<T> {
  let authorizing = false
  let challenge: ConsoleMcpError["challenge"]
  const fetchWithTimeout = withTimeout(options.timeoutMs ?? requestTimeoutMs, scope)
  const headers = connection.bearer ? { authorization: `Bearer ${connection.bearer}` } : {}
  const attempt = async (sessionId: string | undefined) => {
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      ...(connection.auth === "oauth" ? { authProvider: oauthProvider(scope, connection, () => { authorizing = true }) } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: async (input, init) => {
        const response = await fetchWithTimeout(input, init)
        if (response.status === 401) challenge = extractWWWAuthenticateParams(response)
        return response
      },
      ...(sessionId ? { sessionId } : {}),
    })
    if (sessionId && connection.protocolVersion) transport.setProtocolVersion(connection.protocolVersion)
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
      if (!sessionId || !(error instanceof StreamableHTTPError) || error.code !== 404) throw error
      delete connection.sessionId
      return await attempt(undefined)
    }
  }
  catch (error) {
    if (error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401)) {
      if (connection.oauth?.pending) delete connection.oauth.pending
      connection.status = "signed-out"
      connection.error = { bearer: "The server rejected this token.", none: "The server asks for credentials.", oauth: "The server rejected the grant. Sign in again." }[connection.auth]
      delete connection.sessionId
      throw Object.assign(new ConsoleMcpError(409, "CONSOLE_MCP_SIGNED_OUT", connection.error), { challenge })
    }
    if (error instanceof McpError || error instanceof ConsoleMcpError) throw error
    connection.status = "failed"
    if (authorizing) {
      if (connection.oauth?.pending && !connection.oauth.pending.url) delete connection.oauth.pending
      connection.error = `OAuth sign-in could not start: ${failureMessage(error)}`
      throw new ConsoleMcpError(502, "CONSOLE_MCP_AUTHORIZATION_FAILED", connection.error)
    }
    connection.error = failureMessage(error)
    throw new ConsoleMcpError(502, "CONSOLE_MCP_UNREACHABLE", connection.error)
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

async function save(scope: ConsoleMcpScope, connection: StoredConnection): Promise<void> {
  if (!connectionRuntimes.get(connection.id)?.closing) await scope.records.save(connection)
}

async function owned(scope: ConsoleMcpScope): Promise<StoredConnection[]> {
  const connections = await scope.records.connections(scope.userId, scope.projectId)
  await Promise.all(connections.filter(connection => prune(connection)).map(connection => save(scope, connection)))
  return connections.sort((left, right) => left.createdAt - right.createdAt)
}

async function connectionOf(scope: ConsoleMcpScope, id: string): Promise<StoredConnection> {
  const connection = await scope.records.connection(scope.userId, scope.projectId, id)
  if (!connection) throw new ConsoleMcpError(404, "CONSOLE_NOT_FOUND", "This MCP connection does not exist. It was disconnected.")
  assertOpen(connectionRuntimes.get(connection.id))
  if (prune(connection)) await save(scope, connection)
  return connection
}

async function withConnection<T>(scope: ConsoleMcpScope, id: string, change: (connection: StoredConnection) => Promise<T>): Promise<T> {
  return serialize(id, "operation", async (runtime) => {
    assertOpen(runtime)
    const connection = await connectionOf(scope, id)
    runtime.connection = connection
    try {
      const value = await change(connection)
      assertOpen(runtime)
      return value
    }
    finally {
      await save(scope, connection)
    }
  })
}

async function discoverAppServers(scope: ConsoleMcpScope): Promise<ConsoleMcpCandidate[]> {
  const origin = scope.appOrigin
  const cached = discovered.get(origin)
  if (cached && Date.now() - cached.at < discoveryLifetimeMs) return cached.servers
  const servers: ConsoleMcpCandidate[] = []
  const response = await withTimeout(5_000, scope)(`${origin}/.well-known/oauth-protected-resource`, { headers: { accept: "application/json" } }).catch(() => undefined)
  const metadata: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
  if (isRecord(metadata)) {
    const resource = text(metadata.resource)
    const url = resource && URL.canParse(resource) ? new URL(resource) : undefined
    if (url && url.origin === origin) {
      const authorizationServers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : []
      const authorizationServer = text(authorizationServers[0])
      servers.push({ label: text(metadata.resource_name) ?? "This app", url: url.href, ...(authorizationServer ? { authorizationServer } : {}) })
    }
  }
  discovered.set(origin, { at: Date.now(), servers })
  return servers
}

/** The connections of the caller on the project, and the MCP servers that the project's app announces. */
export async function listConsoleMcp(scope: ConsoleMcpScope): Promise<ConsoleMcpOverview> {
  return {
    connections: (await owned(scope)).map(describe),
    servers: await discoverAppServers(scope),
    sharedSession: false,
  }
}

function signInScope(discovery: OAuthDiscoveryState, requested: string | undefined): string | undefined {
  const scope = requested || discovery.resourceMetadata?.scopes_supported?.join(" ")
  if (scope?.split(" ").includes("offline_access") || !discovery.authorizationServerMetadata?.scopes_supported?.includes("offline_access")) return scope
  return scope ? `${scope} offline_access` : "offline_access"
}

function startAuthorization(scope: ConsoleMcpScope, connection: StoredConnection, prompt: "login" | undefined, challenge?: ConsoleMcpError["challenge"]): Promise<string> {
  return withClientOperation(connection, () => authorize(scope, connection, prompt, challenge))
}

async function authorize(scope: ConsoleMcpScope, connection: StoredConnection, prompt: "login" | undefined, challenge?: ConsoleMcpError["challenge"]): Promise<string> {
  const oauth = connection.oauth!
  oauth.pending = { expiresAt: Date.now() + pendingLifetimeMs, state: randomId(), ...(prompt ? { prompt } : {}) }
  oauth.tokens = undefined
  delete connection.sessionId
  const fetchFn = withTimeout(requestTimeoutMs, scope)
  try {
    const known = oauth.discovery?.resourceMetadataUrl
    const resourceMetadataUrl = challenge?.resourceMetadataUrl ?? (known ? new URL(known) : undefined)
    const found = await discoverOAuthServerInfo(connection.url, { fetchFn, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) })
    oauth.discovery = { ...found, ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}) }
    const scopeText = signInScope(oauth.discovery, challenge?.scope)
    const result = await auth(oauthProvider(scope, connection), { fetchFn, serverUrl: connection.url, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scopeText ? { scope: scopeText } : {}) })
    if (result === "REDIRECT" && oauth.pending.url) {
      connection.status = "authorizing"
      delete connection.error
      return oauth.pending.url
    }
    throw new ConsoleMcpError(502, "CONSOLE_MCP_AUTHORIZATION_FAILED", "The authorization server did not start a sign-in.")
  }
  catch (error) {
    delete oauth.pending
    connection.status = "failed"
    connection.error = `OAuth sign-in could not start: ${failureMessage(error)}`
    throw new ConsoleMcpError(502, "CONSOLE_MCP_AUTHORIZATION_FAILED", connection.error)
  }
}

/**
 * Connect to an MCP server. A pasted `token` is sent as a bearer token. Without one, the Console first connects without
 * credentials; a server that answers `401` starts the MCP authorization flow, and the result names the URL to open.
 */
export async function connectConsoleMcp(scope: ConsoleMcpScope, input: { label?: string | undefined, prompt?: "login" | undefined, server: string, token?: string | undefined }): Promise<ConsoleMcpConnectResult> {
  const url = consoleMcpServerUrl(input.server, scope)
  const token = text(input.token)
  if ((await owned(scope)).length >= maximumConnections) throw new ConsoleMcpError(409, "CONSOLE_CONFLICT", `The Console keeps ${maximumConnections} MCP connections per person and project. Disconnect one first.`)
  const connection: StoredConnection = {
    auth: token ? "bearer" : "none",
    ...(token ? { bearer: token } : {}),
    createdAt: Date.now(),
    id: `mcp_${randomId(12)}`,
    label: text(input.label)?.slice(0, 80) ?? url.host + (url.pathname === "/" ? "" : url.pathname),
    labelled: Boolean(text(input.label)),
    projectId: scope.projectId,
    sameOrigin: url.origin === scope.appOrigin,
    status: "failed",
    url: url.href,
    userId: scope.userId,
  }
  try {
    await withClient(scope, connection, async () => {}, { fresh: true })
    await save(scope, connection)
    return { connection: describe(connection) }
  }
  catch (error) {
    if (!isSignedOut(error) || connection.auth !== "none") throw error
    connection.auth = "oauth"
    connection.oauth = { redirectUrl: scope.redirectUrl }
    try {
      return { authorizationUrl: await startAuthorization(scope, connection, input.prompt, error.challenge), connection: describe(connection) }
    }
    finally {
      await save(scope, connection)
    }
  }
}

interface CompleteInput {
  code?: string | undefined
  error?: string | undefined
  errorDescription?: string | undefined
  iss?: string | undefined
  state: string
}

/** Finish the sign-in that the authorization server sent the browser back from. */
export async function completeConsoleMcp(scope: ConsoleMcpScope, input: CompleteInput): Promise<ConsoleMcpConnection> {
  const connection = (await owned(scope)).find(candidate => candidate.oauth?.pending?.state === input.state)
  if (!connection?.oauth?.pending || completingAuthorizations.has(input.state)) throw new ConsoleMcpError(404, "CONSOLE_MCP_AUTHORIZATION_FAILED", "This sign-in is not known. It expired, finished already, was started by someone else, or on another project. Start it again.")
  completingAuthorizations.add(input.state)
  try {
    return await withConnection(scope, connection.id, async (current) => {
      if (current.oauth?.pending?.state !== input.state) throw new ConsoleMcpError(404, "CONSOLE_MCP_AUTHORIZATION_FAILED", "This sign-in is not known. Start it again.")
      return finishSignIn(scope, current, input)
    })
  }
  finally {
    completingAuthorizations.delete(input.state)
  }
}

async function finishSignIn(scope: ConsoleMcpScope, connection: StoredConnection, input: CompleteInput): Promise<ConsoleMcpConnection> {
  const oauth = connection.oauth!
  const pending = oauth.pending!
  if (input.error || !input.code) {
    delete oauth.pending
    connection.status = oauth.tokens ? "signed-out" : "failed"
    connection.error = input.error === "access_denied" ? "The sign-in was denied." : `The authorization server returned ${text(input.error) ?? "no code"}${input.errorDescription ? `: ${input.errorDescription.slice(0, 200)}` : "."}`
    throw new ConsoleMcpError(400, "CONSOLE_MCP_AUTHORIZATION_FAILED", connection.error)
  }
  const metadata: Record<string, unknown> = { ...oauth.discovery?.authorizationServerMetadata }
  const missingIssuer = metadata.authorization_response_iss_parameter_supported === true && !input.iss
  if (missingIssuer || (input.iss !== undefined && input.iss !== metadata.issuer)) {
    delete oauth.pending
    connection.status = "failed"
    connection.error = missingIssuer ? "The authorization server did not return its issuer." : "The sign-in came back from another authorization server."
    throw new ConsoleMcpError(400, "CONSOLE_MCP_AUTHORIZATION_FAILED", connection.error)
  }
  const code = input.code
  return withClientOperation(connection, async () => {
    try {
      const result = await auth(oauthProvider(scope, connection), { authorizationCode: code, fetchFn: withTimeout(requestTimeoutMs, scope), serverUrl: connection.url })
      if (result !== "AUTHORIZED") throw new ConsoleMcpError(502, "CONSOLE_MCP_AUTHORIZATION_FAILED", "The authorization server did not issue a token.")
    }
    catch (error) {
      delete oauth.pending
      connection.status = "failed"
      connection.error = `The token exchange failed: ${failureMessage(error)}`
      throw new ConsoleMcpError(502, "CONSOLE_MCP_AUTHORIZATION_FAILED", connection.error)
    }
    if (pending === oauth.pending) delete oauth.pending
    const identity = await readIdentity(scope, connection)
    if (identity) connection.identity = identity
    else delete connection.identity
    if (!connection.labelled) connection.label = connection.identity?.name ?? connection.identity?.email ?? connection.label
    await runClient(scope, connection, async () => {}, { fresh: true })
    return describe(connection)
  })
}

/** Sign in again, or open a new MCP session. OAuth connections return the URL to open. */
export async function reconnectConsoleMcp(scope: ConsoleMcpScope, input: { id: string, prompt?: "login" | undefined }): Promise<ConsoleMcpConnectResult> {
  return withConnection(scope, input.id, async (connection) => {
    if (connection.auth === "oauth" && (input.prompt || connection.status === "signed-out" || connection.status === "authorizing" || !connection.oauth?.tokens)) {
      return { authorizationUrl: await startAuthorization(scope, connection, input.prompt), connection: describe(connection) }
    }
    try {
      await withClient(scope, connection, async () => {}, { fresh: true })
    }
    catch (error) {
      if (!isSignedOut(error) || connection.auth !== "oauth") throw error
      return { authorizationUrl: await startAuthorization(scope, connection, input.prompt, error.challenge), connection: describe(connection) }
    }
    return { connection: describe(connection) }
  })
}

async function revoke(scope: ConsoleMcpScope, connection: StoredConnection): Promise<boolean> {
  const oauth = connection.oauth
  const metadata: Record<string, unknown> = { ...oauth?.discovery?.authorizationServerMetadata }
  const endpoint = text(metadata.revocation_endpoint)
  const client = oauth?.client ?? (oauth ? await scope.records.client(clientKey(connection, oauth)) : undefined)
  if (!oauth?.tokens || !endpoint || !client) return false
  const tokens = [[oauth.tokens.refresh_token, "refresh_token"], [oauth.tokens.access_token, "access_token"]] as const
  let revoked = false
  for (const [token, hint] of tokens) {
    if (!token) continue
    const body = new URLSearchParams({ client_id: client.client_id, token, token_type_hint: hint })
    if (client.client_secret) body.set("client_secret", client.client_secret)
    const response = await withTimeout(requestTimeoutMs, scope)(endpoint, { body, headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST" }).catch(() => undefined)
    revoked ||= Boolean(response?.ok)
  }
  return revoked
}

/** End the MCP session, revoke the OAuth tokens, and forget the connection. */
export async function disconnectConsoleMcp(scope: ConsoleMcpScope, input: { id: string }): Promise<{ revoked: boolean, sessionEnded: boolean }> {
  let connection = await connectionOf(scope, input.id)
  const runtime = runtimeOf(connection.id)
  runtime.closing = true
  try {
    await scope.records.remove(connection)
    await runtime.operation
    await runtime.clientOperation
    connection = runtime.connection ?? connection
    await scope.records.remove(connection)
    let sessionEnded = false
    if (connection.sessionId) {
      const headers: Record<string, string> = { "mcp-session-id": connection.sessionId }
      const bearer = connection.bearer ?? connection.oauth?.tokens?.access_token
      if (bearer) headers.authorization = `Bearer ${bearer}`
      if (connection.protocolVersion) headers["mcp-protocol-version"] = connection.protocolVersion
      const response = await withTimeout(requestTimeoutMs, scope)(connection.url, { headers, method: "DELETE" }).catch(() => undefined)
      sessionEnded = Boolean(response?.ok)
    }
    return { revoked: await revoke(scope, connection), sessionEnded }
  }
  finally {
    connectionRuntimes.delete(connection.id)
  }
}

const listMethods: Readonly<Record<ConsoleMcpListKind, { field: string, method: "prompts/list" | "resources/list" | "resources/templates/list" | "tools/list" }>> = {
  "prompts": { field: "prompts", method: "prompts/list" },
  "resource-templates": { field: "resourceTemplates", method: "resources/templates/list" },
  "resources": { field: "resources", method: "resources/list" },
  "tools": { field: "tools", method: "tools/list" },
}

/** One page of tools, resources, resource templates, or prompts. */
export async function listConsoleMcpItems(scope: ConsoleMcpScope, input: { cursor?: string | undefined, id: string, kind: ConsoleMcpListKind }): Promise<ConsoleMcpPage & { connection: ConsoleMcpConnection }> {
  return withConnection(scope, input.id, async (connection) => {
    const { field, method } = listMethods[input.kind]
    try {
      const result = await withClient(scope, connection, client => client.request({ method, params: input.cursor ? { cursor: input.cursor } : {} }, ResultSchema, { timeout: requestTimeoutMs }))
      const values: unknown = Reflect.get(result, field)
      const items = Array.isArray(values) ? values.filter(isRecord) : []
      const nextCursor = text(Reflect.get(result, "nextCursor"))
      return { connection: describe(connection), items, ...(nextCursor ? { nextCursor } : {}) }
    }
    catch (error) {
      if (error instanceof McpError && error.code === -32601) return { connection: describe(connection), items: [] }
      throw error
    }
  })
}

async function outcome(scope: ConsoleMcpScope, id: string, request: { method: "prompts/get" | "resources/read" | "tools/call", params: Record<string, unknown> }, timeoutMs: number): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return withConnection(scope, id, async (connection) => {
    const startedAt = performance.now()
    try {
      const result = await withClient(scope, connection, client => client.request(request, ResultSchema, { maxTotalTimeout: timeoutMs, timeout: timeoutMs }), { timeoutMs })
      return { connection: describe(connection), durationMs: Math.round(performance.now() - startedAt), result }
    }
    catch (error) {
      if (!(error instanceof McpError)) throw error
      connection.status = "connected"
      return {
        connection: describe(connection),
        durationMs: Math.round(performance.now() - startedAt),
        error: { code: error.code, message: error.message.replace(/^(?:MCP error -?\d+: )+/, ""), ...(error.data === undefined ? {} : { data: error.data }) },
      }
    }
  })
}

/** Call a tool. The answer holds the result, or the JSON-RPC error of the server. */
export function callConsoleMcpTool(scope: ConsoleMcpScope, input: { arguments?: Record<string, unknown> | undefined, id: string, tool: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(scope, input.id, { method: "tools/call", params: { arguments: input.arguments ?? {}, name: input.tool } }, callTimeoutMs)
}

/** Read a resource. */
export function readConsoleMcpResource(scope: ConsoleMcpScope, input: { id: string, uri: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(scope, input.id, { method: "resources/read", params: { uri: input.uri } }, requestTimeoutMs)
}

/** Get a prompt with its arguments. */
export function getConsoleMcpPrompt(scope: ConsoleMcpScope, input: { arguments?: Record<string, string> | undefined, id: string, name: string }): Promise<ConsoleMcpOutcome & { connection: ConsoleMcpConnection }> {
  return outcome(scope, input.id, { method: "prompts/get", params: { arguments: input.arguments ?? {}, name: input.name } }, requestTimeoutMs)
}

/** Forget the sessions, sign-ins, and discovered servers of this process. Tests use it. */
export function resetConsoleMcp(): void {
  connectionRuntimes.clear()
  completingAuthorizations.clear()
  discovered.clear()
}
