import { connectionEnvAccess } from "@vite-hub/env/internal/connections"
import { errorCode, logFailure } from "@vite-hub/internal/runtime/request-log"
import * as v from "valibot"
import { decodeJwt } from "jose"

import { isChatGPTProvider } from "./chatgpt.ts"
import { chatgptDynamicClientId, chatgptIssuer, chatgptResource, chatgptScopes, verifyChatGPTIdentity } from "./internal/chatgpt-identity.ts"
import { assertChatGPTCallback, chatgptCallbackClient, chatgptRevocationEndpoint, chatgptTerminalRefreshErrors, chatgptTokenMetadata } from "./internal/chatgpt-flow.ts"
import { chatgptTransferSchema, registerChatGPTTransfers } from "./internal/chatgpt-transfer.ts"
import type { ChatGPTTransfer } from "./internal/chatgpt-transfer.ts"
import { registerChatGPTCredentialUse } from "./internal/agent-credential.ts"
import type { UseChatGPTCredential } from "./internal/agent-credential.ts"
import { createRequestScheduler } from "./requests.ts"
import { providerAccount } from "./account.ts"
import { createConnectionTransport, isMcpEndpoint } from "./transport.ts"
import { isApiKeyProvider } from "./api-key.ts"
import { isConnectionError, isEnvBridgeError } from "./errors.ts"
import { connectionsErrorDiagnostics } from "./error-diagnostics.ts"
import { isConnectionDefinition, isConnectionInstances } from "./definition.ts"
import { codeChallenge, randomToken } from "./internal/oauth-crypto.ts"
import { clientRegistrations, discoverAuthorizationServer } from "./internal/oauth-discovery.ts"
import type { AuthorizationServer } from "./internal/oauth-discovery.ts"
import { CONNECTION_NAME_MAX_LENGTH, isConnectionReadMethod } from "./types.ts"
import { callerActor, callerInheritedActors, decide, decisionActor, envActor } from "./policy.ts"
import { connectionActions, prepareConnectionMethod } from "./catalog.ts"

import type { EnvAccessContext, EnvActivity } from "@vite-hub/env/bridge"
import type { EnvStoreRotation } from "@vite-hub/env/database"
import type { ConnectionState, ConnectionStore } from "./store.ts"
import type {
  ConnectionAccount,
  ConnectionApproval,
  ConnectionApprovalPage,
  ConnectionApprovalStatus,
  ConnectionDefinition,
  ConnectionFetchInit,
  ConnectionInspection,
  ConnectionInstancesDefinition,
  ConnectionProvider,
  ConnectionTokenResponse,
  ConnectionValue,
  UseConnectionOptions,
} from "./types.ts"

const REFRESH_WINDOW_MS = 60_000
const REFRESH_LEASE_MS = 60_000
const REFRESH_WAIT_MS = 30_000
const AUTHORIZATION_TTL_MS = 10 * 60_000
const APPROVAL_EXECUTION_TTL_MS = 5 * 60_000
const API_KEY_PATTERN = /^[\x21-\x7e]{1,8192}$/
const FALLBACK_GRANT = "fallback"

interface StoredToken {
  chatgpt?: v.InferOutput<typeof chatgptTokenMetadata>
  client?: { id: string, key: string, secret?: string }
  grantId?: string
  accountId?: string
  accessToken: string
  expiresAt?: number
  refreshToken?: string
  scopes: string[]
  tokenType: string
}

export interface ConnectionsRuntimeOptions {
  /**
   * Connection definitions by name, or loaders that import them. A keyed definition with `instances`
   * defines one Connection per instance, named `<name>:<instance>`.
   */
  definitions: Readonly<Record<string, ConnectionDefinition | ConnectionInstancesDefinition | (() => Promise<unknown>)>>
  store: ConnectionStore | (() => ConnectionStore | Promise<ConnectionStore>)
  /**
   * Markdown by definition name, or loaders that read it, from the `<name>.md` next to each definition file.
   * A definition's own `docs` wins.
   */
  docs?: Readonly<Record<string, string | (() => Promise<string>)>>
  fetch?: typeof fetch
  now?: () => number
  /** Host adapter override. By default one durable Connections store is one host. */
  chatgptHostId?: () => Promise<string>
}

interface CallContext {
  transport: ReturnType<typeof createConnectionTransport>
  actor: string
  approved?: boolean
  approvedGrantId?: string
  definition: ConnectionDefinition
  inherited?: readonly string[]
  name: string
  options: UseConnectionOptions
  providerExecution?: { dispatched: boolean, rejected: boolean }
}

type SendInit = { headers?: Record<string, string>, redirect?: RequestInit["redirect"], signal?: AbortSignal }

interface ProviderRequest {
  action: string
  body?: string
  highRisk: boolean
  input?: unknown
  json?: boolean
  method: string
  url: string
  write: boolean
}

type ApprovalInput =
  | { input: unknown, kind: "method" }
  | { body?: string, headers?: Record<string, string>, kind: "fetch", method: string, redirect?: RequestInit["redirect"], url: string }

/** An untyped client. `useConnection()` wraps it in the typed client tree. */
export interface ConnectionRuntimeClient {
  call: (action: string, input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  fetch: (input: string | URL, init?: ConnectionFetchInit) => Promise<Response>
}

export interface ConnectionCallback {
  /**
   * The manager that started the flow with `authorize()`, such as `user:<id>`. Leave it out only for a flow that the
   * Console started with `via: "console"`: the signed Console call checked the manager, so the callback completes it as
   * that manager.
   */
  actor?: string
  code?: string
  error?: string
  clientId?: string
  state: string
}

/**
 * The Connections runtime. Every method that decides something (`approve`, `deny`, `authorize`,
 * `complete`, `revoke`, `setKey`) requires `actor`, such as `user:<id>`, and records it. There is no default actor.
 */
export interface ConnectionsRuntime {
  activity: (input: { before?: string, name: string }) => Promise<readonly EnvActivity[]>
  approvals: (input?: { before?: string, name?: string, status?: ConnectionApprovalStatus }) => Promise<ConnectionApprovalPage>
  /** Approve a pending write and run it under the actor that requested it. */
  approve: (input: { actor: string, id: string }) => Promise<{ approval: ConnectionApproval, result?: unknown }>
  /**
   * Start an OAuth flow with PKCE and return the provider URL. The `state` and its PKCE verifier work one time, until
   * `expiresAt`. `via: "console"` marks a flow that a signed Console call started: its callback needs no app session.
   */
  authorize: (input: { actor: string, name: string, redirectUri: string, via?: "console" }) => Promise<{ expiresAt: string, state: string, url: string }>
  client: (name: string, options: UseConnectionOptions) => ConnectionRuntimeClient
  /**
   * Exchange the authorization code and store the token. `state` is single-use. `actor` must be the
   * actor that started the flow with `authorize()`.
   */
  complete: (input: ConnectionCallback) => Promise<ConnectionInspection>
  definition: (name: string) => Promise<ConnectionDefinition>
  deny: (input: { actor: string, id: string }) => Promise<ConnectionApproval>
  inspect: (name: string) => Promise<ConnectionInspection>
  list: () => Promise<ConnectionInspection[]>
  revoke: (input: { actor: string, name: string }) => Promise<ConnectionInspection>
  /**
   * Re-encrypt every stored token with the current key, the first of `VITEHUB_CONNECTIONS_KEYS`. Run it after you add
   * a new current key, then remove the previous key. A token that a refresh replaces during the rotation keeps the
   * refresh.
   */
  rotateKey: () => Promise<EnvStoreRotation>
  /** Store the key of an API key Connection. The provider `verify` check runs first. */
  setKey: (input: { actor: string, key: string, name: string }) => Promise<ConnectionInspection>
}

const storedTokenSchema = v.object({
  chatgpt: v.optional(chatgptTokenMetadata),
  client: v.optional(v.object({ id: v.string(), key: v.string(), secret: v.optional(v.string()) })),
  grantId: v.optional(v.string()),
  accountId: v.optional(v.string()),
  accessToken: v.string(),
  expiresAt: v.optional(v.number()),
  refreshToken: v.optional(v.string()),
  scopes: v.array(v.string()),
  tokenType: v.string(),
})
const tokenResponseSchema = v.object({
  earliest_refresh_at: v.optional(v.pipe(v.number(), v.finite())),
  access_token: v.string(),
  expires_in: v.optional(v.number()),
  id_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
})
const apiKeyVerificationSchema = v.union([
  v.boolean(),
  v.object({ account: v.optional(v.object({ email: v.optional(v.string()), id: v.pipe(v.string(), v.minLength(1)) })) }),
])
const sealedValueSchema = v.object({ unseal: v.function() })
const inheritedActorsSchema = v.optional(v.array(v.pipe(v.string(), v.startsWith("agent:"), v.minLength(7), v.maxLength(518))))
const approvalInputSchema = v.variant("kind", [
  v.object({ grantId: v.optional(v.string()), inherited: inheritedActorsSchema, input: v.unknown(), kind: v.literal("method") }),
  v.object({ grantId: v.optional(v.string()), inherited: inheritedActorsSchema, body: v.optional(v.string()), headers: v.optional(v.record(v.string(), v.string())), kind: v.literal("fetch"), method: v.string(), redirect: v.optional(v.picklist(["error", "follow", "manual"])), url: v.string() }),
])

function isDiscovered(provider: ConnectionProvider): boolean {
  return provider.mcp !== undefined && (!provider.authorizationEndpoint || !provider.tokenEndpoint || provider.clientId === undefined)
}

interface OAuthClient {
  account?: ConnectionProvider["account"]
  authorizationEndpoint: string
  authorizationParams?: Readonly<Record<string, string>>
  chatgpt?: true
  clientId: string
  clientSecret?: string
  id: string
  identityScopes?: readonly string[]
  registered?: string
  resource?: string
  revocationEndpoint?: string
  tokenEndpoint: string
}

const CONSOLE_STATE_PREFIX = "console_"

/** Whether a `state` belongs to a flow that a signed Console call started with `authorize({ via: "console" })`. */
export function isConsoleState(state: string): boolean {
  return state.startsWith(CONSOLE_STATE_PREFIX)
}

async function resolveValue(value: ConnectionValue | undefined): Promise<string | undefined> {
  return v.is(v.string(), value) || value === undefined ? value : await value()
}

function tokenKey(name: string): string {
  return `connection/${name}`
}

function splitScopes(scope: string | undefined): string[] | undefined {
  return scope?.split(/\s+/).filter(Boolean)
}

function parseToken(value: string, name: string): StoredToken {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  }
  catch {
    throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_STORED_DATA({ connection: name, problem: "token" })
  }
  const token = v.safeParse(storedTokenSchema, parsed)
  if (!token.success) {
    throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name })
  }
  return token.output
}

async function providerMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json()
    const parsed = v.safeParse(v.object({ error: v.object({ message: v.string() }) }), body)
    return parsed.success ? parsed.output.error.message.slice(0, 300) : undefined
  }
  catch {
    return undefined
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "invalid-json" })
  }
}

type ConnectionModule = ConnectionDefinition | ConnectionInstancesDefinition

function isConnectionModule(value: unknown): value is ConnectionModule {
  return isConnectionDefinition(value) || isConnectionInstances(value)
}

/** Create the Connections runtime. Applications normally use `useConnection()` instead. */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions): ConnectionsRuntime {
  const fetchProvider = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init))
  const request = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (init?.redirect !== "error") return await fetchProvider(input, init)
    const response = await fetchProvider(input, { ...init, redirect: "manual" })
    if (response.type === "opaqueredirect" || [301, 302, 303, 307, 308].includes(response.status)) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "redirect", status: response.status })
    return response
  }
  const scheduler = createRequestScheduler()
  const hostId = options.chatgptHostId ?? (async () => (await import("./internal/chatgpt-host.ts")).chatgptHostId((await getStore()).secrets))
  const now = options.now ?? Date.now
  const refreshing = new Map<string, Promise<StoredToken>>()
  const tokenMutations = new Map<string, Promise<void>>()
  async function withTokenMutation<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = tokenMutations.get(name)
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    tokenMutations.set(name, current)
    if (previous) await previous
    try {
      return await run()
    }
    finally {
      release()
      if (tokenMutations.get(name) === current) tokenMutations.delete(name)
    }
  }
  let store: Promise<ConnectionStore> | undefined
  const definitions = new Map<string, Promise<ConnectionModule | undefined>>()
  const instanceDefinitions = new Map<string, ConnectionDefinition>()

  const getStore = () => (store ??= Promise.resolve().then(() => v.is(v.function(), options.store) ? options.store() : options.store).catch((error: unknown) => {
    store = undefined
    throw error
  }))

  async function loadDefinition(name: string): Promise<ConnectionModule | undefined> {
    const entry = Object.hasOwn(options.definitions, name) ? options.definitions[name] : undefined
    if (!entry) return undefined
    if (isConnectionModule(entry)) return entry
    if (!v.is(v.function(), entry)) return undefined
    let loaded = definitions.get(name)
    if (!loaded) {
      loaded = entry().then((module) => {
        if (isConnectionModule(module)) return module
        const parsedModule = v.safeParse(v.object({ default: v.unknown() }), module)
        return parsedModule.success && isConnectionModule(parsedModule.output.default) ? parsedModule.output.default : undefined
      }).then((result) => {
        if (!result) definitions.delete(name)
        return result
      }, (error: unknown) => {
        definitions.delete(name)
        throw error
      })
      definitions.set(name, loaded)
    }
    return await loaded
  }

  async function definition(name: string): Promise<ConnectionDefinition> {
    if (name !== name.trim()) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_NAME({ problem: "whitespace" })
    }
    if (name.length > CONNECTION_NAME_MAX_LENGTH) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_NAME({ problem: "length" })
    }
    const loaded = await loadDefinition(name)
    if (loaded && isConnectionInstances(loaded)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ connection: name, instances: loaded.instances, problem: "instances" })
    }
    if (loaded) return loaded
    const separator = name.lastIndexOf(":")
    const group = separator > 0 ? await loadDefinition(name.slice(0, separator)) : undefined
    const instance = name.slice(separator + 1)
    if (!group || !isConnectionInstances(group) || !group.instances.includes(instance)) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_FOUND({ connection: name })
    let resolved = instanceDefinitions.get(name)
    if (!resolved) {
      const candidate: unknown = group.definition(instance)
      if (!isConnectionDefinition(candidate)) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ connection: name, problem: "instance" })
      resolved = candidate
      instanceDefinitions.set(name, resolved)
    }
    return resolved
  }

  async function connectionNames(): Promise<string[]> {
    const names: string[] = []
    for (const name of Object.keys(options.definitions).sort()) {
      let loaded: ConnectionModule | undefined
      try {
        loaded = await loadDefinition(name)
      }
      catch (error) {
        logFailure({ field: "connections", fields: { op: "list", connection: name }, message: "Connections could not load a Connection Definition", error }, () => {
          console.warn(`[vitehub] Connections could not load the Connection Definition "${name}". It is left out of the list.`, error)
        })
        continue
      }
      if (loaded && isConnectionInstances(loaded)) names.push(...loaded.instances.map(instance => `${name}:${instance}`))
      else names.push(name)
    }
    return names
  }

  function envContext(store: ConnectionStore, name: string, permission: "activity" | "replace" | "use", actor: string, options: UseConnectionOptions = {}): EnvAccessContext {
    return connectionEnvAccess(store.bridge, {
      actor: envActor(actor),
      name,
      permission,
      traceId: options.traceId,
      invocationId: options.invocationId,
    })
  }

  async function recordDenied(name: string, actor: string, action: string, options: UseConnectionOptions): Promise<void> {
    const event: EnvActivity = {
      action: "use",
      actor: envActor(actor),
      id: crypto.randomUUID(),
      key: tokenKey(name),
      operation: action,
      operationId: crypto.randomUUID(),
      outcome: "denied",
      timestamp: new Date(now()).toISOString(),
      traceId: options.traceId,
      invocationId: options.invocationId,
    }
    await (await getStore()).access.append(event)
  }

  const authorizationServers = new Map<string, Promise<AuthorizationServer>>()
  const registrations = clientRegistrations({ now, request, secrets: async () => (await getStore()).secrets })

  function authorizationServer(mcp: string, name: string): Promise<AuthorizationServer> {
    let pending = authorizationServers.get(mcp)
    if (!pending) {
      pending = discoverAuthorizationServer(mcp, request, name)
      authorizationServers.set(mcp, pending)
      pending.catch(() => {
        if (authorizationServers.get(mcp) === pending) authorizationServers.delete(mcp)
      })
    }
    return pending
  }

  async function oauthEndpoints(provider: ConnectionProvider, name: string, discover = false): Promise<{ authorizationEndpoint: string, revocationEndpoint?: string, server?: AuthorizationServer, tokenEndpoint: string }> {
    const server = provider.mcp && (discover || !provider.authorizationEndpoint || !provider.tokenEndpoint) ? await authorizationServer(provider.mcp, name) : undefined
    const revocationEndpoint = provider.revocationEndpoint ?? server?.revocationEndpoint
    return {
      // SAFETY: the definition check requires both endpoints, or an `mcp` endpoint whose metadata lists them.
      authorizationEndpoint: (provider.authorizationEndpoint ?? server?.authorizationEndpoint)!,
      tokenEndpoint: (provider.tokenEndpoint ?? server?.tokenEndpoint)!,
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
      ...(server ? { server } : {}),
    }
  }

  async function oauthClient(definition: ConnectionDefinition, name: string, input: { chatgptClientId?: string, pending?: { id: string, key: string }, redirectUri?: string, token?: StoredToken } = {}): Promise<OAuthClient> {
    const provider = definition.provider
    if (isChatGPTProvider(provider)) return {
      id: "chatgpt", chatgpt: true, clientId: input.chatgptClientId ?? chatgptDynamicClientId,
      authorizationEndpoint: `${chatgptIssuer}/api/accounts/authorize`,
      tokenEndpoint: `${chatgptIssuer}/api/accounts/oauth/token`,
      identityScopes: chatgptScopes,
    }
    if (isApiKeyProvider(provider)) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey: true, connection: name })
    const clientId = await resolveValue(provider.clientId)
    if (!clientId && !provider.mcp) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ problem: "client-id", provider: provider.id })
    const endpoints = await oauthEndpoints(provider, name, !clientId)
    const declaredParams = Object.hasOwn(provider, "authorizationParams") ? provider.authorizationParams : undefined
    const resource = endpoints.server ? declaredParams?.resource ?? endpoints.server.resource : undefined
    const authorizationParams = resource ? { ...declaredParams, resource } : declaredParams
    const base = {
      ...(provider.account ? { account: provider.account } : {}),
      authorizationEndpoint: endpoints.authorizationEndpoint,
      ...(authorizationParams ? { authorizationParams } : {}),
      id: provider.id,
      ...(provider.identityScopes ? { identityScopes: provider.identityScopes } : {}),
      ...(resource ? { resource } : {}),
      ...(endpoints.revocationEndpoint ? { revocationEndpoint: endpoints.revocationEndpoint } : {}),
      tokenEndpoint: endpoints.tokenEndpoint,
    }
    if (clientId) {
      const clientSecret = await resolveValue(provider.clientSecret)
      return { ...base, clientId, ...(clientSecret ? { clientSecret } : {}) }
    }
    if (input.pending) {
      const current = await registrations.stored(input.pending.key)
      const secret = current?.clientId === input.pending.id ? current.clientSecret : undefined
      return { ...base, clientId: input.pending.id, ...(secret ? { clientSecret: secret } : {}), registered: input.pending.key }
    }
    if (input.token) {
      if (!input.token.client) throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name, problem: "rejected" })
      const { id, key, secret } = input.token.client
      return { ...base, clientId: id, ...(secret ? { clientSecret: secret } : {}), registered: key }
    }
    // SAFETY: `oauthEndpoints()` discovers the server when the provider has no client id.
    const server = endpoints.server!
    if (!input.redirectUri) throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name, problem: "rejected" })
    const scopes = [...new Set([...(provider.identityScopes ?? []), ...(definition.scopes ?? [])])]
    const client = await registrations.client(server, { clientName: provider.clientName ?? new URL(input.redirectUri).host, connection: name, redirectUri: input.redirectUri, scopes })
    return { ...base, clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), registered: client.key }
  }

  async function tokenRequest(provider: OAuthClient, parameters: Record<string, string>, signal?: AbortSignal, onDispatch?: () => void, onResponse?: () => void, connectionName?: string): Promise<ConnectionTokenResponse> {
    const { clientId, clientSecret } = provider
    const form = new URLSearchParams({ ...parameters, client_id: clientId })
    if (clientSecret) form.set("client_secret", clientSecret)
    if (provider.resource) form.set("resource", provider.resource)
    if (provider.chatgpt) {
      chatgptCallbackClient(clientId)
      form.set("resource", chatgptResource)
    }
    onDispatch?.()
    const response = await request(provider.tokenEndpoint, {
      body: form,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
      signal,
    }).catch((error: unknown) => {
      if (provider.chatgpt) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "token-request", provider: "chatgpt" })
      throw error
    })
    const body: unknown = await response.json().catch(() => undefined)
    const parsedError = v.safeParse(v.object({ error: v.string() }), body)
    const error = parsedError.success ? parsedError.output.error : undefined
    if (!response.ok || error) {
      if (!provider.chatgpt || (response.status === 400 || response.status === 401)
        && error !== undefined && (error === "invalid_client" || chatgptTerminalRefreshErrors.has(error))) onResponse?.()
      const forgotten = provider.registered !== undefined && (error === "invalid_client" || error === "unauthorized_client")
      if (forgotten) await registrations.forget(provider.registered!, clientId)
      throw forgotten || error === "invalid_grant" || provider.chatgpt && error !== undefined && chatgptTerminalRefreshErrors.has(error)
        ? connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: connectionName ?? provider.id, problem: "rejected" })
        : connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ message: provider.chatgpt ? error === "invalid_client" ? "invalid_client" : undefined : error, problem: "token-request", provider: provider.id, status: response.status })
    }
    const token = v.safeParse(tokenResponseSchema, body)
    if (!token.success || provider.chatgpt && (
      !token.output.access_token || !token.output.refresh_token || !Number.isFinite(token.output.expires_in)
      || token.output.expires_in! <= 0 || token.output.token_type?.toLowerCase() !== "bearer"
    )) {
      throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "no-token", provider: provider.id })
    }
    onResponse?.()
    return token.output
  }

  function toStoredToken(
    response: ConnectionTokenResponse,
    previous?: StoredToken,
    requestedScopes?: readonly string[],
  ): StoredToken {
    return {
      chatgpt: previous?.chatgpt ? { ...previous.chatgpt, idToken: response.id_token ?? previous.chatgpt.idToken, earliestRefreshAt: response.earliest_refresh_at === undefined ? undefined : response.earliest_refresh_at * 1000 } : undefined,
      accountId: previous?.accountId,
      ...(previous?.client ? { client: previous.client } : {}),
      grantId: previous?.grantId,
      accessToken: response.access_token,
      expiresAt: response.expires_in === undefined ? undefined : now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? previous?.refreshToken,
      scopes: splitScopes(response.scope) ?? (requestedScopes ? [...requestedScopes] : previous?.scopes ?? []),
      tokenType: response.token_type ?? "Bearer",
    }
  }

  function expiresSoon(token: StoredToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - now() < (token.chatgpt ? 15 * 60_000 : REFRESH_WINDOW_MS)
      && (token.chatgpt?.earliestRefreshAt === undefined || token.chatgpt.earliestRefreshAt <= now())
  }

  async function setStatus(name: string, patch: Partial<ConnectionState>, revision: string | null): Promise<boolean> {
    const connections = await getStore()
    const current = await connections.state.get(name)
    const state: ConnectionState = {
      name,
      scopes: [],
      status: "connected",
      ...current,
      ...patch,
      updatedAt: new Date(now()).toISOString(),
    }
    return await connections.state.putForToken(state, revision)
  }

  async function readCurrentToken(name: string): Promise<StoredToken> {
    const current = await (await getStore()).secrets.read(tokenKey(name))
    if (!current) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name })
    return parseToken(current.value, name)
  }

  async function refreshToken(name: string, definition: ConnectionDefinition, stale: string, force: boolean): Promise<StoredToken> {
    const connections = await getStore()
    const key = tokenKey(name)
    const owner = randomToken()
    const deadline = Date.now() + REFRESH_WAIT_MS
    while (true) {
      await requireConnected(name)
      const stored = await connections.secrets.read(key)
      if (!stored) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name })
      if (!stored.revision) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONFIGURED({ missing: "revisions" })
      const latest = parseToken(stored.value, name)
      if (latest.accessToken !== stale && !expiresSoon(latest)) return latest
      if (!force && !expiresSoon(latest)) return latest
      if (!latest.refreshToken) {
        if (!await setStatus(name, { status: "reauth_required" }, stored.revision)) return await readCurrentToken(name)
        throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name, problem: "refresh-token" })
      }
      if (!connections.refreshLeases) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONFIGURED({ missing: "leases" })
      const lease = await connections.refreshLeases.claim({ expiresAt: now() + REFRESH_LEASE_MS, name, now: now(), owner, revision: stored.revision })
      if (lease === "expired") {
        await setStatus(name, { status: "reauth_required" }, stored.revision)
        throw unresolvedMutation(name)
      }
      if (lease === "busy") {
        if (Date.now() >= deadline) throw connectionsErrorDiagnostics.CONNECTIONS_UNAVAILABLE({ connection: name })
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }
      let dispatched = false
      let rejected = false
      let releaseLease = true
      try {
        if ((await connections.secrets.read(key))?.revision !== stored.revision) continue
        return await refreshLeasedToken(name, definition, latest, stored.revision, () => { dispatched = true }, () => { rejected = true })
      }
      catch (error) {
        if (dispatched && !rejected) {
          releaseLease = await connections.secrets.inspect(key)
            .then(current => setStatus(name, { status: "reauth_required" }, current?.revision ?? null))
            .catch(() => false)
        }
        throw error
      }
      finally {
        if (releaseLease) await connections.refreshLeases.release(name, owner).catch(() => undefined)
      }
    }
  }

  async function refreshLeasedToken(name: string, definition: ConnectionDefinition, latest: StoredToken, tokenRevision: string, onDispatch: () => void, onRejected: () => void): Promise<StoredToken> {
    const connections = await getStore()
    const key = tokenKey(name)
    let response: ConnectionTokenResponse
    let dispatched = false
    let responded = false
    try {
      const client = await oauthClient(definition, name, { chatgptClientId: latest.chatgpt?.clientId, token: latest })
      response = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: latest.refreshToken! }, AbortSignal.timeout(REFRESH_WAIT_MS), () => { dispatched = true; onDispatch() }, () => { responded = true }, name)
    }
    catch (error) {
      if (!dispatched) throw error
      if (responded && isConnectionError(error, ["CONNECTIONS_PROVIDER_FAILED"])) {
        onRejected()
        throw error
      }
      if (isChatGPTProvider(definition.provider) && isConnectionError(error, ["CONNECTIONS_NEEDS_RECONNECT"])) {
        const cleared = await connections.bridge.replace(envContext(connections, name, "replace", "connections"), { expectedRevision: tokenRevision, key, value: JSON.stringify({ reauthRequired: true }) })
        await setStatus(name, { status: "reauth_required" }, cleared.revision)
      }
      else if (!await setStatus(name, { status: "reauth_required" }, tokenRevision)) return await readCurrentToken(name)
      if (isConnectionError(error, ["CONNECTIONS_NEEDS_RECONNECT"])) {
        throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name })
      }
      throw error
    }
    if (latest.chatgpt && response.id_token) await verifyChatGPTIdentity({ clientId: latest.chatgpt.clientId, idToken: response.id_token, subject: latest.accountId, request, now: now() })
    const next = toStoredToken(response, latest)
    let revision: string
    try {
      const replacement = await withTokenMutation(name, () => connections.bridge.replace(envContext(connections, name, "replace", "connections"), { expectedRevision: tokenRevision ?? null, key, value: JSON.stringify(next) }))
      revision = replacement.revision
    }
    catch (error) {
      if (!isEnvBridgeError(error, "ENV_BRIDGE_CONFLICT")) throw error
      const current = await connections.secrets.read(key)
      if (!current) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name })
      return parseToken(current.value, name)
    }
    if (!await setStatus(name, { ...(next.chatgpt ? { chatgpt: { clientId: next.chatgpt.clientId, expiresAt: next.expiresAt } } : {}), refreshedAt: new Date(now()).toISOString(), scopes: next.scopes, status: "connected" }, revision)) return await readCurrentToken(name)
    return next
  }

  function refresh(name: string, definition: ConnectionDefinition, stale: string, force: boolean): Promise<StoredToken> {
    const key = `${name}\0${stale}`
    let pending = refreshing.get(key)
    if (!pending) {
      pending = refreshToken(name, definition, stale, force).finally(() => refreshing.delete(key))
      refreshing.set(key, pending)
    }
    return pending
  }

  async function requireConnected(name: string, apiKey?: boolean): Promise<void> {
    const state = await (await getStore()).state.get(name)
    if (state?.status === "connected") return
    throw state?.status === "reauth_required"
      ? connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ apiKey, connection: name })
      : connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey, connection: name })
  }

  async function readFallbackKey(name: string, definition: ConnectionDefinition): Promise<string | undefined> {
    const provider = definition.provider
    if (!isApiKeyProvider(provider) || !provider.fallback) return undefined
    let value: unknown = await provider.fallback()
    if (v.is(sealedValueSchema, value)) value = value.unseal()
    const key = v.is(v.string(), value) ? value.trim() : undefined
    if (!key) return undefined
    if (!API_KEY_PATTERN.test(key)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_PROVIDER({ connection: name, problem: "fallback-key" })
    }
    return key
  }

  async function fallbackFor(context: CallContext): Promise<{ connections?: ConnectionStore, key: string } | undefined> {
    const provider = context.definition.provider
    if (!isApiKeyProvider(provider) || !provider.fallback) return undefined
    if (context.approved && context.approvedGrantId !== FALLBACK_GRANT) return undefined
    const connections = await getStore().catch(() => undefined)
    if (connections && await connections.state.get(context.name) !== undefined) return undefined
    const key = await readFallbackKey(context.name, context.definition)
    return key === undefined ? undefined : { connections, key }
  }

  async function dispatch(context: CallContext, providerRequest: ProviderRequest, init: SendInit, token: { accessToken: string, tokenType: string }): Promise<Response> {
    if (providerRequest.write && context.providerExecution) {
      context.providerExecution.dispatched = true
      context.providerExecution.rejected = false
    }
    const response = await context.transport.send(providerRequest.url, token, {
      body: providerRequest.body,
      json: providerRequest.json,
      headers: init.headers,
      method: providerRequest.method,
      redirect: init.redirect,
      signal: init.signal,
    })
    if (providerRequest.write && context.providerExecution) {
      context.providerExecution.rejected = response.status >= 400 && response.status < 500 && response.status !== 408
    }
    return response
  }

  async function checkResponse(providerRequest: ProviderRequest, response: Response): Promise<Response> {
    if (response.ok || providerRequest.action === "fetch") return response
    const message = await providerMessage(response)
    throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ action: providerRequest.action, message, status: response.status })
  }

  async function sendWithFallback(context: CallContext, providerRequest: ProviderRequest, init: SendInit, fallback: { connections?: ConnectionStore, key: string }): Promise<Response> {
    if (fallback.connections?.refreshLeases) {
      const owner = await claimMutationLease(context.name)
      try {
        if (await fallback.connections.state.get(context.name) !== undefined) {
          throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: context.name })
        }
      }
      finally {
        await fallback.connections.refreshLeases.release(context.name, owner).catch(() => undefined)
      }
    }
    const operationId = crypto.randomUUID()
    const record = async (outcome: EnvActivity["outcome"]) => {
      await fallback.connections?.access.append({
        action: "use",
        actor: envActor(context.actor),
        id: crypto.randomUUID(),
        key: tokenKey(context.name),
        operation: providerRequest.action,
        operationId,
        outcome,
        revision: FALLBACK_GRANT,
        timestamp: new Date(now()).toISOString(),
        traceId: context.options.traceId,
        invocationId: context.options.invocationId,
      })
    }
    await record("started")
    let response: Response
    try {
      response = await checkResponse(providerRequest, await dispatch(context, providerRequest, init, { accessToken: fallback.key, tokenType: "api-key" }))
    }
    catch (error) {
      await record("failed").catch(() => undefined)
      throw error
    }
    await record("succeeded")
    return response
  }

  async function send(context: CallContext, providerRequest: ProviderRequest, init: SendInit = {}): Promise<Response> {
    const fallback = await fallbackFor(context)
    if (fallback) return await sendWithFallback(context, providerRequest, init, fallback)
    const connections = await getStore()
    const apiKey = isApiKeyProvider(context.definition.provider)
    await requireConnected(context.name, apiKey)
    let failure: unknown
    try {
      return await connections.bridge.use(envContext(connections, context.name, "use", context.actor, context.options), tokenKey(context.name), providerRequest.action, async (secret) => {
        try {
          let token = parseToken(secret.unseal(), context.name)
          if (context.approved && (!context.approvedGrantId || token.grantId !== context.approvedGrantId)) {
            throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_APPROVAL({ problem: "previous-grant" })
          }
          if (expiresSoon(token)) token = await refresh(context.name, context.definition, token.accessToken, false)
          const call = async (current: StoredToken) => {
            if (context.approved && (!context.approvedGrantId || current.grantId !== context.approvedGrantId)) {
              throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_APPROVAL({ problem: "previous-grant" })
            }
            return await dispatch(context, providerRequest, init, current)
          }
          let response = await call(token)
          if (response.status === 401 && !isApiKeyProvider(context.definition.provider)) {
            void response.body?.cancel().catch(() => undefined)
            token = await refresh(context.name, context.definition, token.accessToken, true)
            response = await call(token)
          }
          return await checkResponse(providerRequest, response)
        }
        catch (error) {
          failure = error
          throw error
        }
      })
    }
    catch (error) {
      if (failure) throw failure
      if (isEnvBridgeError(error, "ENV_BRIDGE_MISSING")) {
        throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey, connection: context.name })
      }
      throw error
    }
  }

  async function approvalGrant(context: CallContext): Promise<string> {
    if (await fallbackFor(context)) return FALLBACK_GRANT
    const apiKey = isApiKeyProvider(context.definition.provider)
    await requireConnected(context.name, apiKey)
    const current = await (await getStore()).secrets.read(tokenKey(context.name))
    const token = current ? parseToken(current.value, context.name) : undefined
    if (!token?.grantId) {
      throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ apiKey, connection: context.name, problem: "approval" })
    }
    return token.grantId
  }

  async function governed(context: CallContext, providerRequest: ProviderRequest, approvalInput: ApprovalInput, init: SendInit = {}): Promise<Response | undefined> {
    envActor(context.actor)
    for (const parent of context.inherited ?? []) envActor(parent)
    const decision = decide({
      action: providerRequest.action,
      actor: context.actor,
      approved: context.approved,
      definition: context.definition,
      highRisk: providerRequest.highRisk,
      inherited: context.inherited,
      mcp: providerRequest.action === "fetch" && isMcpEndpoint(context.definition.provider.mcp, providerRequest.url),
      write: providerRequest.write,
    })
    if (decision === "deny") {
      await recordDenied(context.name, context.actor, providerRequest.action, context.options).catch(() => undefined)
      throw connectionsErrorDiagnostics.CONNECTIONS_DENIED({ action: providerRequest.action, actor: context.actor, connection: context.name })
    }
    if (providerRequest.write && context.options.dryRun) {
      context.options.onEffect?.({
        kind: providerRequest.action,
        payload: {
          connection: context.name,
          input: providerRequest.input,
          method: providerRequest.method,
          url: providerRequest.url,
        },
        read: false,
        skipped: "dry-run",
      })
      return undefined
    }
    if (decision === "approve") {
      if (context.options.rejectApprovals) {
        await recordDenied(context.name, context.actor, providerRequest.action, context.options).catch(() => undefined)
        throw connectionsErrorDiagnostics.CONNECTIONS_DENIED({ action: providerRequest.action, actor: context.actor, connection: context.name, immediate: true })
      }
      const grantId = await approvalGrant(context)
      const approval: ConnectionApproval = {
        action: providerRequest.action,
        actor: context.actor,
        createdAt: new Date(now()).toISOString(),
        id: `approval_${randomToken().slice(0, 20)}`,
        input: { ...approvalInput, grantId, ...(context.inherited?.length ? { inherited: [...context.inherited] } : {}) },
        name: context.name,
        status: "pending",
        traceId: context.options.traceId,
        invocationId: context.options.invocationId,
      }
      await (await getStore()).approvals.create(approval)
      throw connectionsErrorDiagnostics.CONNECTIONS_APPROVAL_REQUIRED({ action: providerRequest.action, approval: approval.id, connection: context.name })
    }
    return await send(context, providerRequest, init)
  }

  async function callMethod(context: CallContext, action: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const prepared = prepareConnectionMethod(context.name, context.definition, action, input)
    context.transport.prepare(prepared.url)
    const response = await governed(context, { ...prepared, input, json: true }, { input, kind: "method" }, { signal })
    return response ? await readResponse(response) : undefined
  }

  async function callFetch(context: CallContext, input: string | URL, init: ConnectionFetchInit = {}): Promise<Response | undefined> {
    const url = new URL(input)
    const method = new Request(url, { method: init.method ?? "GET" }).method
    const write = !isConnectionReadMethod(method)
    const headers = context.transport.prepare(url, init.headers)
    if (init.body !== undefined && init.body !== null && !v.is(v.string(), init.body)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_INPUT({})
    }
    const body = init.body ?? undefined
    return await governed(
      context,
      { action: "fetch", body, highRisk: false, input: { method, url: url.toString() }, method, url: url.toString(), write },
      { body, headers, kind: "fetch", method, redirect: init.redirect, url: url.toString() },
      { headers, redirect: init.redirect, signal: init.signal ?? undefined },
    )
  }

  function buildClient(name: string, options: UseConnectionOptions): ConnectionRuntimeClient {
    let context: Promise<CallContext> | undefined
    const resolveContext = () => (context ??= (async () => {
      const actor = callerActor(options)
      const inherited = callerInheritedActors(options)
      const loaded = await definition(name)
      if (isChatGPTProvider(loaded.provider)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_CLIENT()
      return { actor, definition: loaded, inherited, name, options, transport: createConnectionTransport(name, loaded, fetchProvider, scheduler) }
    })())
    return {
      async call(action: string, input?: unknown, callOptions?: { signal?: AbortSignal }): Promise<unknown> {
        return await callMethod(await resolveContext(), action, input, callOptions?.signal)
      },
      async fetch(input: string | URL, init?: ConnectionFetchInit): Promise<Response> {
        return await callFetch(await resolveContext(), input, init) ?? new Response(null, { status: 204 })
      },
    }
  }

  async function connectionDocs(name: string, loaded: ConnectionDefinition): Promise<{ docs?: string }> {
    const separator = name.lastIndexOf(":")
    const colocated = options.docs?.[name] ?? (separator > 0 ? options.docs?.[name.slice(0, separator)] : undefined)
    const docs = loaded.docs ?? (typeof colocated === "function" ? await colocated() : colocated)
    return docs?.trim() ? { docs } : {}
  }

  async function inspect(name: string): Promise<ConnectionInspection> {
    const loaded = await definition(name)
    const provider = loaded.provider
    const apiKeyProvider = isApiKeyProvider(provider)
    const hasFallback = isApiKeyProvider(provider) && provider.fallback !== undefined
    let connections: ConnectionStore | undefined
    let storeFailure: { error: unknown } | undefined
    try {
      connections = await getStore()
    }
    catch (error) {
      if (!hasFallback) throw error
      if (!isConnectionError(error, ["CONNECTIONS_NOT_CONFIGURED"])) storeFailure = { error }
    }
    const state = await connections?.state.get(name)
    const declared = isChatGPTProvider(provider) ? [...chatgptScopes] : [...(loaded.scopes ?? [])]
    const granted = state?.scopes ?? []
    const fallbackRead: { key?: string | undefined, keyError?: string } | undefined = hasFallback && state === undefined
      ? await readFallbackKey(name, loaded).then(key => ({ key }), (error: unknown) => ({ keyError: errorCode(error) ?? "Error" }))
      : undefined
    const fallback = fallbackRead?.key !== undefined
    if (!fallback && storeFailure) throw storeFailure.error
    const keyError = fallbackRead?.keyError
    const keySource = fallback || keyError ? "fallback" : apiKeyProvider && state?.status === "connected" ? "stored" : undefined
    return {
      account: state?.accountId ? { id: state.accountId, email: state.accountEmail } : undefined,
      actions: connectionActions(loaded),
      connectedAt: state?.connectedAt,
      ...(isChatGPTProvider(provider) ? {
        expiresAt: state?.status === "connected" && state.chatgpt?.expiresAt ? new Date(state.chatgpt.expiresAt).toISOString() : undefined,
        chatgpt: { clientId: state?.chatgpt?.clientId, hostId: await hostId(), plan: state?.status === "connected" && chatgptScopes.every(scope => granted.includes(scope)) ? "enabled" as const : "disabled" as const },
      } : {}),
      credential: apiKeyProvider ? "api-key" : isChatGPTProvider(provider) ? "chatgpt" : "oauth2",
      ...await connectionDocs(name, loaded),
      ...(loaded.provider.mcp ? { mcp: loaded.provider.mcp } : {}),
      ...(keySource ? { keySource } : {}),
      ...(keyError ? { keyError } : {}),
      name,
      provider: provider.id,
      refreshedAt: state?.refreshedAt,
      scopes: {
        declared,
        granted,
        missing: state?.status === "connected" ? declared.filter(scope => !granted.includes(scope)) : declared,
      },
      status: fallback ? "connected" : state?.status ?? "disconnected",
    }
  }

  async function authorize(input: { actor: string, name: string, redirectUri: string, via?: "console" }): Promise<{ expiresAt: string, state: string, url: string }> {
    const actor = decisionActor(input.actor)
    const loaded = await definition(input.name)
    const chatgpt = isChatGPTProvider(loaded.provider)
    if (chatgpt && input.via === "console") throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_LOOPBACK()
    const connections = await getStore()
    const registration = chatgpt ? await connections.state.get(input.name) : undefined
    const redirect = new URL(input.redirectUri)
    if (chatgpt) assertChatGPTCallback(input.redirectUri)
    else if (redirect.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "redirect-uri" })
    }
    const provider = await oauthClient(loaded, input.name, { chatgptClientId: registration?.chatgpt?.clientId, redirectUri: redirect.toString() })
    const clientId = provider.clientId
    const state = input.via === "console" ? `${CONSOLE_STATE_PREFIX}${randomToken()}` : randomToken()
    const verifier = randomToken()
    const nonce = chatgpt ? randomToken() : undefined
    const host = chatgpt ? await hostId() : undefined
    const expiresAt = now() + AUTHORIZATION_TTL_MS
    await connections.authorizations.put({
      actor,
      expiresAt,
      name: input.name,
      redirectUri: redirect.toString(), state, verifier,
      ...(nonce ? { chatgpt: { clientId, nonce, subject: registration?.accountId } } : {}),
      ...(provider.registered ? { client: { id: clientId, key: provider.registered } } : {}),
    })
    const url = new URL(provider.authorizationEndpoint)
    const scopes = [...new Set([...(provider.identityScopes ?? []), ...(loaded.scopes ?? [])])]
    for (const [parameter, value] of Object.entries({
      ...provider.authorizationParams,
      client_id: clientId,
      code_challenge: await codeChallenge(verifier), code_challenge_method: "S256",
      redirect_uri: redirect.toString(), response_type: "code", scope: scopes.join(" "), state,
    })) url.searchParams.set(parameter, value)
    if (isChatGPTProvider(loaded.provider) && nonce && host) {
      url.searchParams.set("nonce", nonce)
      url.searchParams.set("ext_agent_host_id", host)
      url.searchParams.set("resource", chatgptResource)
      if (clientId === chatgptDynamicClientId) url.searchParams.set("agent_name_hint", loaded.provider.appName)
      else if (registration?.accountEmail) url.searchParams.set("login_hint", registration.accountEmail)
      if (registration?.status === "connected" && !registration.scopes.includes("chatgpt.tokens.use.direct")) url.searchParams.set("prompt", "consent")
    }
    return { expiresAt: new Date(expiresAt).toISOString(), state, url: url.toString() }
  }

  async function complete(input: ConnectionCallback): Promise<ConnectionInspection> {
    const actor = input.actor === undefined && isConsoleState(input.state) ? undefined : decisionActor(input.actor)
    const connections = await getStore()
    const authorization = await connections.authorizations.take(input.state)
    if (!authorization || authorization.expiresAt <= now()) throw connectionsErrorDiagnostics.CONNECTIONS_AUTHORIZATION_EXPIRED()
    if (actor !== undefined && authorization.actor !== actor) throw connectionsErrorDiagnostics.CONNECTIONS_FORBIDDEN({ problem: "authorization-actor" })
    if (input.error === "access_denied") throw connectionsErrorDiagnostics.CONNECTIONS_AUTHORIZATION_CANCELLED()
    if (input.error) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "token-request" })
    if (!input.code) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "body" })
    const name = authorization.name
    const loaded = await definition(name)
    const chatgpt = isChatGPTProvider(loaded.provider)
    if (chatgpt && !authorization.chatgpt) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_REGISTRATION()
    const clientId = authorization.chatgpt ? chatgptCallbackClient(authorization.chatgpt.clientId, input.clientId) : undefined
    const provider = await oauthClient(loaded, name, { chatgptClientId: clientId, ...(authorization.client ? { pending: authorization.client } : {}), redirectUri: authorization.redirectUri })
    const owner = await claimMutationLease(name)
    let releaseLease = true
    let quarantine = false
    try {
      if (chatgpt) {
        const currentRegistration = (await connections.state.get(name))?.chatgpt?.clientId
        if (currentRegistration && currentRegistration !== clientId) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_REGISTRATION()
      }
      const response = await tokenRequest(provider, {
        code: input.code,
        code_verifier: authorization.verifier,
        grant_type: "authorization_code",
        redirect_uri: authorization.redirectUri,
      }, AbortSignal.timeout(REFRESH_WAIT_MS), () => { releaseLease = false; quarantine = true }, () => { releaseLease = true; quarantine = false })
      releaseLease = false
      quarantine = true
      let account: ConnectionAccount | undefined
      try {
        account = chatgpt && authorization.chatgpt && clientId
          ? await verifyChatGPTIdentity({ clientId, idToken: response.id_token, nonce: authorization.chatgpt.nonce, subject: authorization.chatgpt.subject, request, now: now() })
          : providerAccount(provider, response)
      }
      catch (error) {
        quarantine = true
        throw error
      }
      const key = tokenKey(name)
      let current: Awaited<ReturnType<typeof connections.secrets.read>>
      let previous: ReturnType<typeof v.safeParse<typeof storedTokenSchema>> | undefined
      let state: Awaited<ReturnType<typeof connections.state.get>>
      try {
        current = await connections.secrets.read(key)
        previous = current ? v.safeParse(storedTokenSchema, JSON.parse(current.value)) : undefined
        state = await connections.state.get(name)
      }
      catch (error) {
        quarantine = true
        throw error
      }
      const accountId = previous?.success ? previous.output.accountId ?? state?.accountId : state?.status === "revoked" ? undefined : state?.accountId
      if (accountId && (!account || accountId !== account.id)) {
        throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT(account ? { connection: name, problem: "other-account" } : { problem: "unknown-account", provider: provider.id })
      }
      const token = toStoredToken(response, previous?.success ? previous.output : undefined, chatgpt ? [] : [
        ...new Set([...(provider.identityScopes ?? []), ...(loaded.scopes ?? [])]),
      ])
      if (provider.registered) token.client = { id: provider.clientId, key: provider.registered, ...(provider.clientSecret ? { secret: provider.clientSecret } : {}) }
      else delete token.client
      if (chatgpt && clientId && response.id_token) token.chatgpt = {
        clientId, idToken: response.id_token,
        earliestRefreshAt: response.earliest_refresh_at === undefined ? undefined : response.earliest_refresh_at * 1000,
      }
      token.accountId = account?.id
      token.grantId = randomToken()
      releaseLease = false
      quarantine = true
      const replacement = await connections.bridge.replace(envContext(connections, name, "replace", authorization.actor), { expectedRevision: current?.revision ?? null, key, value: JSON.stringify(token) })
      const timestamp = new Date(now()).toISOString()
      const persisted = await connections.state.putForToken({
        ...(token.chatgpt ? { chatgpt: { clientId: token.chatgpt.clientId, expiresAt: token.expiresAt } } : {}),
        accountEmail: account?.email,
        accountId: account?.id,
        connectedAt: timestamp,
        name,
        refreshedAt: timestamp,
        scopes: token.scopes,
        status: "connected",
        updatedAt: timestamp,
      }, replacement.revision)
      if (!persisted) throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT({ problem: "authorization" })
      releaseLease = true
      return await inspect(name)
    }
    catch (error) {
      if (!releaseLease && quarantine) {
        const current = await connections.secrets.inspect(tokenKey(name)).catch(() => undefined)
        await setStatus(name, { status: "reauth_required" }, current?.revision ?? null).catch(() => undefined)
      }
      throw error
    }
    finally {
      if (releaseLease) await connections.refreshLeases.release(name, owner).catch(() => undefined)
    }
  }

  function unresolvedMutation(name: string) {
    return connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name, problem: "mutation" })
  }

  async function claimMutationLease(name: string): Promise<string> {
    const connections = await getStore()
    if (!connections.refreshLeases) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONFIGURED({ missing: "leases" })
    const owner = randomToken()
    const deadline = Date.now() + REFRESH_WAIT_MS
    while (true) {
      const revision = (await connections.secrets.inspect(tokenKey(name)))?.revision ?? "unconnected"
      const lease = await connections.refreshLeases.claim({ expiresAt: now() + REFRESH_LEASE_MS, name, now: now(), owner, revision })
      if (lease === "acquired") return owner
      if (lease === "expired") {
        await setStatus(name, { status: "reauth_required" }, revision === "unconnected" ? null : revision)
        throw unresolvedMutation(name)
      }
      if (Date.now() >= deadline) throw connectionsErrorDiagnostics.CONNECTIONS_UNAVAILABLE({ connection: name })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  async function revoke(input: { actor: string, name: string }): Promise<ConnectionInspection> {
    const actor = decisionActor(input.actor)
    const loaded = await definition(input.name)
    const connections = await getStore()
    const key = tokenKey(input.name)
    const revocationEndpoint = isChatGPTProvider(loaded.provider) ? await chatgptRevocationEndpoint(request) : isApiKeyProvider(loaded.provider) ? undefined : (await oauthEndpoints(loaded.provider, input.name, isDiscovered(loaded.provider))).revocationEndpoint
    const owner = await claimMutationLease(input.name)
    let releaseLease = true
    let providerFailure: Error | undefined
    let providerRevoked = false
    let leasedRevision: string | undefined
    try {
      const stored = await connections.secrets.inspect(key)
      let revision: string | null = null
      if (stored) {
        if (!revocationEndpoint && !isApiKeyProvider(loaded.provider)) {
          throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ problem: "revocation", provider: loaded.provider.id })
        }
        revision = await connections.bridge.use(envContext(connections, input.name, "use", actor), key, "revoke", async (secret, metadata) => {
          if (!metadata?.revision) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONFIGURED({ missing: "bridge-revision" })
          leasedRevision = metadata.revision
          let token: StoredToken | undefined
          try {
            token = parseToken(secret.unseal(), input.name)
          }
          catch {}
          if (token && revocationEndpoint) {
            releaseLease = false
            const response = await request(revocationEndpoint, {
              body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken, ...(token.chatgpt ? { client_id: token.chatgpt.clientId, token_type_hint: "refresh_token" } : {}), ...(token.client ? { client_id: token.client.id, ...(token.client.secret ? { client_secret: token.client.secret } : {}) } : {}) }),
              redirect: "error",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              method: "POST",
              signal: AbortSignal.timeout(REFRESH_WAIT_MS),
            })
            if (response.ok) providerRevoked = true
            await response.arrayBuffer()
            if (!response.ok) {
              providerFailure = connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ action: "revoke", status: response.status })
              throw providerFailure
            }
            releaseLease = true
          }
          releaseLease = false
          const replacement = await connections.bridge.replace(envContext(connections, input.name, "replace", actor), { expectedRevision: metadata.revision, key, value: JSON.stringify({ revoked: true }) })
          return replacement.revision
        })
      }
      if (!await setStatus(input.name, { status: "revoked" }, revision)) throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT({ problem: "revocation" })
      releaseLease = true
      return await inspect(input.name)
    }
    catch (error) {
      if (providerRevoked) {
        await (async () => {
          const current = await connections.secrets.read(key)
          if (!current?.revision) return
          const value: unknown = JSON.parse(current.value)
          const revoked = v.is(v.object({ revoked: v.literal(true) }), value)
          if (!revoked && current.revision !== leasedRevision) return
          const persisted = await setStatus(input.name, { status: revoked ? "revoked" : "reauth_required" }, current.revision)
          if (revoked && persisted) releaseLease = true
        })().catch(() => undefined)
      }
      throw providerFailure ?? error
    }
    finally {
      if (releaseLease) await connections.refreshLeases.release(input.name, owner).catch(() => undefined)
    }
  }

  async function verifyKey(name: string, provider: ConnectionDefinition["provider"], key: string): Promise<ConnectionAccount | undefined> {
    if (!isApiKeyProvider(provider) || !provider.verify) return undefined
    let result: unknown
    try {
      result = await provider.verify(key, { fetch: request, signal: AbortSignal.timeout(REFRESH_WAIT_MS) })
    }
    catch (error) {
      let preserve = false
      try {
        if (isConnectionError(error)) {
          const why = Reflect.get(error, "why")
          const code = Reflect.get(error, "code")
          preserve = typeof why === "string" && typeof code === "string" && !why.includes(key) && !code.includes(key)
        }
      }
      catch {}
      if (preserve) throw error
      throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "verify", provider: provider.id })
    }
    const verification = v.safeParse(apiKeyVerificationSchema, result)
    if (!verification.success) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ problem: "verify-result", provider: provider.id })
    if (verification.output === false) throw connectionsErrorDiagnostics.CONNECTIONS_KEY_REJECTED({ provider: provider.id })
    if (verification.output === true || !verification.output.account) return undefined
    const account: ConnectionAccount = { id: verification.output.account.id }
    if (verification.output.account.email !== undefined) account.email = verification.output.account.email
    return account
  }

  async function setKey(input: { actor: string, key: string, name: string }): Promise<ConnectionInspection> {
    const actor = decisionActor(input.actor)
    const name = input.name
    const loaded = await definition(name)
    if (!isApiKeyProvider(loaded.provider)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ connection: name, problem: "oauth-key" })
    }
    if (!API_KEY_PATTERN.test(input.key)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "api-key-format" })
    }
    const account = await verifyKey(name, loaded.provider, input.key)
    const connections = await getStore()
    const key = tokenKey(name)
    const owner = await claimMutationLease(name)
    let retainLease = false
    let quarantine = false
    try {
      const current = await connections.secrets.inspect(key)
      const token: StoredToken = { accessToken: input.key, accountId: account?.id, grantId: randomToken(), scopes: [], tokenType: "api-key" }
      const replacement = await connections.bridge.replace(envContext(connections, name, "replace", actor), { expectedRevision: current?.revision ?? null, key, value: JSON.stringify(token) })
      retainLease = true
      quarantine = true
      const timestamp = new Date(now()).toISOString()
      const persisted = await connections.state.putForToken({
        accountEmail: account?.email,
        accountId: account?.id,
        connectedAt: timestamp,
        name,
        scopes: [],
        status: "connected",
        updatedAt: timestamp,
      }, replacement.revision)
      if (!persisted) throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT({ problem: "key" })
      const inspection = await inspect(name)
      retainLease = false
      quarantine = false
      return inspection
    }
    catch (error) {
      if (retainLease && quarantine) {
        const current = await connections.secrets.inspect(key).catch(() => undefined)
        await setStatus(name, { status: "reauth_required" }, current?.revision ?? null).catch(() => undefined)
      }
      throw error
    }
    finally {
      if (!retainLease) await connections.refreshLeases.release(name, owner).catch(() => undefined)
    }
  }

  async function list(): Promise<ConnectionInspection[]> {
    return await Promise.all((await connectionNames()).map(name => inspect(name)))
  }

  async function activity(input: { before?: string, name: string }): Promise<readonly EnvActivity[]> {
    await definition(input.name)
    const connections = await getStore()
    return await connections.bridge.activity(envContext(connections, input.name, "activity", "connections"), tokenKey(input.name), input.before)
  }

  async function approvals(input: { before?: string, name?: string, status?: ConnectionApprovalStatus } = {}): Promise<ConnectionApprovalPage> {
    const connections = await getStore()
    await connections.approvals.recover(new Date(now()).toISOString())
    return await connections.approvals.list(input)
  }

  async function approve(input: { actor: string, id: string }): Promise<{ approval: ConnectionApproval, result?: unknown }> {
    const decidedBy = decisionActor(input.actor)
    const connections = await getStore()
    await connections.approvals.recover(new Date(now()).toISOString())
    const decidedAt = new Date(now()).toISOString()
    const executionExpiresAt = new Date(now() + APPROVAL_EXECUTION_TTL_MS).toISOString()
    const approval = await connections.approvals.transition(input.id, "pending", "approved", {
      decidedAt,
      decidedBy,
      executionExpiresAt,
    })
    if (!approval) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ approval: input.id, problem: "not-pending" })
    const leaseAbort = new AbortController()
    const signal = AbortSignal.any([
      AbortSignal.timeout(APPROVAL_EXECUTION_TTL_MS),
      leaseAbort.signal,
    ])
    const heartbeat = setInterval(() => {
      void connections.approvals
        .renew(input.id, new Date(now() + APPROVAL_EXECUTION_TTL_MS).toISOString())
        .then(active => { if (!active) leaseAbort.abort(connectionsErrorDiagnostics.CONNECTIONS_INVALID_APPROVAL({ problem: "lease-lost" })) })
        .catch((error: unknown) => leaseAbort.abort(error))
    }, APPROVAL_EXECUTION_TTL_MS / 3)
    const providerExecution = { dispatched: false, rejected: false }
    try {
      const stored = v.parse(approvalInputSchema, approval.input)
      const loaded = await definition(approval.name)
      const context: CallContext = {
        transport: createConnectionTransport(approval.name, loaded, fetchProvider, scheduler),
        actor: approval.actor,
        approved: true,
        approvedGrantId: stored.grantId,
        inherited: stored.inherited,
        providerExecution,
        definition: loaded,
        name: approval.name,
        options: {
          traceId: approval.traceId,
          invocationId: approval.invocationId,
        },
      }
      let result: unknown
      if (stored.kind === "fetch") {
        const response = await callFetch(context, stored.url, {
          body: stored.body,
          headers: stored.headers,
          method: stored.method,
          redirect: stored.redirect,
          signal,
        })
        result = response ? { status: response.status } : undefined
      }
      else {
        result = await callMethod(context, approval.action, stored.input, signal)
      }
      const executed = await connections.approvals.transition(input.id, "approved", "executed")
      if (!executed) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_APPROVAL({ problem: "lease-lost" })
      const output: { approval: ConnectionApproval; result?: unknown } = {
        approval: executed,
      }
      if (result !== undefined) output.result = result
      return output
    }
    catch (error) {
      const uncertain = signal.aborted || (providerExecution.dispatched && !providerExecution.rejected)
      const failure = uncertain
        ? connectionsErrorDiagnostics.CONNECTIONS_EXECUTION_UNKNOWN({ approval: input.id })
        : error
      const code = isConnectionError(failure) ? failure.code : "CONNECTIONS_REQUEST_FAILED"
      await connections.approvals.transition(input.id, "approved", "failed", { error: code }).catch(() => undefined)
      throw failure
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  async function deny(input: { actor: string, id: string }): Promise<ConnectionApproval> {
    const decidedBy = decisionActor(input.actor)
    const approval = await (await getStore()).approvals.transition(input.id, "pending", "denied", {
      decidedAt: new Date(now()).toISOString(),
      decidedBy,
    })
    if (!approval) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ approval: input.id, problem: "not-pending" })
    return approval
  }

  async function exportChatGPT(input: { actor: string, name: string }): Promise<ChatGPTTransfer> {
    const loaded = await definition(input.name)
    if (!isChatGPTProvider(loaded.provider)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_CLIENT()
    const connections = await getStore()
    const owner = await claimMutationLease(input.name)
    try {
      await requireConnected(input.name)
      const current = await connections.secrets.read(tokenKey(input.name))
      if (!current) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: input.name })
      const token = parseToken(current.value, input.name)
      if (!token.chatgpt || !token.refreshToken || !token.accountId || !token.expiresAt) throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: input.name })
      const state = await connections.state.get(input.name)
      const credential: ChatGPTTransfer = {
        version: 1, issuer: chatgptIssuer, client_id: token.chatgpt.clientId, subject: token.accountId,
        email: state?.accountEmail, access_token: token.accessToken, refresh_token: token.refreshToken,
        id_token: token.chatgpt.idToken, token_type: "Bearer", scopes: token.scopes,
        expires_at: token.expiresAt, ext_agent_host_id: await hostId(),
      }
      if (new TextEncoder().encode(JSON.stringify(credential)).byteLength > 60 * 1024) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_TRANSFER()
      const cleared = await connections.bridge.replace(envContext(connections, input.name, "replace", input.actor), {
        key: tokenKey(input.name), expectedRevision: current.revision ?? null, value: JSON.stringify({ transferred: true }),
      })
      if (!await setStatus(input.name, { status: "reauth_required" }, cleared.revision)) throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT({ problem: "authorization" })
      return credential
    }
    finally { await connections.refreshLeases.release(input.name, owner).catch(() => undefined) }
  }

  async function importChatGPT(input: { actor: string, name: string, credential: unknown }): Promise<ConnectionInspection> {
    const loaded = await definition(input.name)
    if (!isChatGPTProvider(loaded.provider)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_CLIENT()
    const parsed = v.safeParse(chatgptTransferSchema, input.credential)
    if (!parsed.success) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_TRANSFER()
    const credential = parsed.output
    let issuedAt: number
    try {
      const claims = decodeJwt(credential.id_token)
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat * 1000 > now() + 5000) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_IDENTITY()
      issuedAt = claims.iat * 1000
    }
    catch { throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_IDENTITY() }
    const account = await verifyChatGPTIdentity({ clientId: credential.client_id, idToken: credential.id_token, subject: credential.subject, request, now: issuedAt })
    await hostId()
    const connections = await getStore()
    const owner = await claimMutationLease(input.name)
    let releaseLease = true
    try {
      const state = await connections.state.get(input.name)
      if (state?.status === "connected" || state?.chatgpt && (state.chatgpt.clientId !== credential.client_id || state.accountId !== account.id)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_TRANSFER()
      const current = await connections.secrets.inspect(tokenKey(input.name))
      const response = await tokenRequest(await oauthClient(loaded, input.name, { chatgptClientId: credential.client_id }), {
        grant_type: "refresh_token", refresh_token: credential.refresh_token,
      }, AbortSignal.timeout(REFRESH_WAIT_MS), () => { releaseLease = false }, () => { releaseLease = true }, input.name)
      releaseLease = false
      if (response.id_token) await verifyChatGPTIdentity({ clientId: credential.client_id, idToken: response.id_token, subject: account.id, request, now: now() })
      const token = toStoredToken(response, {
        accountId: account.id, grantId: randomToken(), accessToken: credential.access_token,
        refreshToken: credential.refresh_token, scopes: credential.scopes, tokenType: "Bearer",
        chatgpt: { clientId: credential.client_id, idToken: credential.id_token },
      })
      const replacement = await connections.bridge.replace(envContext(connections, input.name, "replace", input.actor), {
        key: tokenKey(input.name), expectedRevision: current?.revision ?? null, value: JSON.stringify(token),
      })
      const timestamp = new Date(now()).toISOString()
      if (!await connections.state.putForToken({ name: input.name, accountId: account.id, accountEmail: account.email,
        chatgpt: { clientId: credential.client_id, expiresAt: token.expiresAt }, scopes: token.scopes,
        connectedAt: timestamp, refreshedAt: timestamp, updatedAt: timestamp, status: "connected",
      }, replacement.revision)) throw connectionsErrorDiagnostics.CONNECTIONS_STATE_CONFLICT({ problem: "authorization" })
      releaseLease = true
      return await inspect(input.name)
    }
    finally { if (releaseLease) await connections.refreshLeases.release(input.name, owner).catch(() => undefined) }
  }

  async function chatgptModels(input: { actor: string, name: string }): Promise<Array<{ id: string, name: string }>> {
    const loaded = await definition(input.name)
    if (!isChatGPTProvider(loaded.provider)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_CLIENT()
    const api = loaded.provider.api
    await requireConnected(input.name)
    const connections = await getStore()
    return await connections.bridge.use(envContext(connections, input.name, "use", input.actor), tokenKey(input.name), "models", async (secret) => {
      let token = parseToken(secret.unseal(), input.name)
      if (expiresSoon(token)) token = await refresh(input.name, loaded, token.accessToken, false)
      if (!chatgptScopes.every(scope => token.scopes.includes(scope))) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_PERMISSION()
      const response = await request(`${api}/models`, { headers: { authorization: `Bearer ${token.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(30_000) })
      const catalog = v.safeParse(v.object({ models: v.array(v.object({ slug: v.string(), display_name: v.string(), visibility: v.string() })) }), await response.json().catch(() => undefined))
      if (!response.ok || !catalog.success) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ action: "models", status: response.status })
      return catalog.output.models.filter(model => model.visibility === "list").map(model => ({ id: model.slug, name: model.display_name }))
    })
  }

  const useChatGPT: UseChatGPTCredential = async (name, input, use) => {
    input.signal?.throwIfAborted()
    const actor = callerActor({ access: input.access })
    const inherited = callerInheritedActors({ access: input.access })
    const loaded = await definition(name)
    if (!isChatGPTProvider(loaded.provider)) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_CLIENT()
    if (decide({ action: "inference", actor, definition: loaded, inherited, highRisk: false, write: false }) !== "allow") {
      await recordDenied(name, actor, "inference", input).catch(() => undefined)
      throw connectionsErrorDiagnostics.CONNECTIONS_DENIED({ connection: name, actor, action: "inference" })
    }
    const connections = await getStore()
    await requireConnected(name)
    const provider = loaded.provider
    let failure: unknown
    try {
      return await connections.bridge.use(envContext(connections, name, "use", actor, input), tokenKey(name), "inference", async (secret) => {
        try {
          let token = parseToken(secret.unseal(), name)
          if (!token.chatgpt) throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name })
          if (expiresSoon(token)) token = await refresh(name, loaded, token.accessToken, false)
          if (!chatgptScopes.every(scope => token.scopes.includes(scope))) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_PERMISSION()
          if (!token.expiresAt || token.expiresAt <= now()) throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name })
          input.signal?.throwIfAborted()
          return await use({ accessToken: token.accessToken, expiresAt: token.expiresAt, api: provider.api,
            clientInfo: { name: provider.appName, title: provider.appName, version: provider.appVersion } })
        }
        catch (error) { failure = error; throw error }
      })
    }
    catch (error) { throw failure ?? error }
  }

  const runtime: ConnectionsRuntime = {
    activity,
    approvals,
    approve,
    authorize,
    client: buildClient,
    complete,
    definition,
    deny,
    inspect,
    list,
    revoke,
    async rotateKey() {
      const store = await getStore()
      if (!store.rotate) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONFIGURED({ missing: "rotation" })
      return await store.rotate()
    },
    setKey,
  }
  registerChatGPTCredentialUse(runtime, useChatGPT)
  registerChatGPTTransfers(runtime, { export: exportChatGPT, import: importChatGPT, models: chatgptModels })
  return runtime
}
