import { connectionEnvAccess } from "@vite-hub/env/internal/connections"
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
import { isLoginProvider } from "./oauth-login.ts"
import { codeChallenge, randomToken } from "./internal/oauth-crypto.ts"
import { createLoginSessions } from "./runtime/login.ts"
import { CONNECTION_NAME_MAX_LENGTH, isConnectionReadMethod } from "./types.ts"
import { callerActor, callerInheritedActors, decide, envActor } from "./policy.ts"
import { connectionActions, prepareConnectionMethod } from "./catalog.ts"

import type { EnvAccessContext, EnvActivity } from "@vite-hub/env/bridge"
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
  ConnectionLoginDefinition,
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
// Visible ASCII only, so the key is a valid header value.
const API_KEY_PATTERN = /^[\x21-\x7e]{1,8192}$/
// The approval grant of a write requested while the provider `fallback` key was in use.
// Stored grants use random 43-character ids, so the two never match.
const FALLBACK_GRANT = "fallback"
// The approval grant of a login provider. Its tokens are in memory, so an approval binds to the provider.
const LOGIN_GRANT = "login"

interface StoredToken {
  chatgpt?: v.InferOutput<typeof chatgptTokenMetadata>
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
  /** The `agent:` actors whose rules an Agent actor inherits through `extends`, nearest first. */
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

/** A stored approval input. Typed methods store their input; `fetch` stores the request. */
type ApprovalInput =
  | { input: unknown, kind: "method" }
  | { body?: string, headers?: Record<string, string>, kind: "fetch", method: string, redirect?: RequestInit["redirect"], url: string }

/** An untyped client. `useConnection()` wraps it in the typed client tree. */
export interface ConnectionRuntimeClient {
  call: (action: string, input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  fetch: (input: string | URL, init?: ConnectionFetchInit) => Promise<Response>
}

export interface ConnectionCallback {
  actor?: string
  code?: string
  error?: string
  clientId?: string
  state: string
}

export interface ConnectionsRuntime {
  activity: (input: { before?: string, name: string }) => Promise<readonly EnvActivity[]>
  approvals: (input?: { before?: string, name?: string, status?: ConnectionApprovalStatus }) => Promise<ConnectionApprovalPage>
  /** Approve a pending write and run it under the actor that requested it. */
  approve: (input: { actor?: string, id: string }) => Promise<{ approval: ConnectionApproval, result?: unknown }>
  /** Start an authorization code flow with PKCE. Returns the provider URL. */
  authorize: (input: { actor?: string, name: string, redirectUri: string }) => Promise<{ state: string, url: string }>
  client: (name: string, options: UseConnectionOptions) => ConnectionRuntimeClient
  /**
   * Exchange the authorization code and store the token. `state` is single-use. `actor` must be the
   * actor that started the flow with `authorize()`. Both default to `user:local`.
   */
  complete: (input: ConnectionCallback) => Promise<ConnectionInspection>
  definition: (name: string) => Promise<ConnectionDefinition>
  deny: (input: { actor?: string, id: string }) => Promise<ConnectionApproval>
  inspect: (name: string) => Promise<ConnectionInspection>
  list: () => Promise<ConnectionInspection[]>
  revoke: (input: { actor?: string, name: string }) => Promise<ConnectionInspection>
  /** Store the key of an API key Connection. The provider `verify` check runs first. */
  setKey: (input: { actor?: string, key: string, name: string }) => Promise<ConnectionInspection>
}

const storedTokenSchema = v.object({
  chatgpt: v.optional(chatgptTokenMetadata),
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
// A replayed approval decides with the inherited actors that the Agent runtime vouched for when it was requested.
const inheritedActorsSchema = v.optional(v.array(v.pipe(v.string(), v.startsWith("agent:"), v.minLength(7), v.maxLength(518))))
const approvalInputSchema = v.variant("kind", [
  v.object({ grantId: v.optional(v.string()), inherited: inheritedActorsSchema, input: v.unknown(), kind: v.literal("method") }),
  v.object({ grantId: v.optional(v.string()), inherited: inheritedActorsSchema, body: v.optional(v.string()), headers: v.optional(v.record(v.string(), v.string())), kind: v.literal("fetch"), method: v.string(), redirect: v.optional(v.picklist(["error", "follow", "manual"])), url: v.string() }),
])

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

/** A Connection Definition, or a keyed definition with `instances`. */
type ConnectionModule = ConnectionDefinition | ConnectionInstancesDefinition

function isConnectionModule(value: unknown): value is ConnectionModule {
  return isConnectionDefinition(value) || isConnectionInstances(value)
}

function isLoginDefinition(definition: ConnectionDefinition): definition is ConnectionLoginDefinition {
  return isLoginProvider(definition.provider)
}

/** Create the Connections runtime. Applications normally use `useConnection()` instead. */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions): ConnectionsRuntime {
  const request = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init))
  const scheduler = createRequestScheduler()
  const hostId = options.chatgptHostId ?? (async () => (await import("./internal/chatgpt-host.ts")).chatgptHostId((await getStore()).secrets))
  const now = options.now ?? Date.now
  const refreshing = new Map<string, Promise<StoredToken>>()
  // Provider revocation can invalidate an entire grant. Serialize token
  // replacements with revocation so a callback or refresh cannot replace a
  // grant after revocation has leased its token but before the provider call.
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
  const logins = createLoginSessions({ now, request })

  // A store factory that throws synchronously still rejects, so callers can treat the store as unavailable.
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
    // Instance keys cannot contain `:`, so the last one separates the definition name from the instance.
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

  /** Connection names, with each instance of a keyed definition as `<name>:<instance>`. */
  async function connectionNames(): Promise<string[]> {
    const names: string[] = []
    for (const name of Object.keys(options.definitions).sort()) {
      let loaded: ConnectionModule | undefined
      try {
        loaded = await loadDefinition(name)
      }
      catch {
        // A broken lazy definition must not hide healthy Connections from discovery.
        continue
      }
      if (loaded && isConnectionInstances(loaded)) names.push(...loaded.instances.map(instance => `${name}:${instance}`))
      else names.push(name)
    }
    return names
  }

  function envContext(store: ConnectionStore, name: string, permission: "activity" | "replace" | "use", actor: string, options: UseConnectionOptions = {}): EnvAccessContext {
    // The Connection access map is the policy. Env grants one permission on this Connection token only.
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

  function oauthProvider(definition: ConnectionDefinition, name: string, clientId?: string): ConnectionProvider & { chatgpt?: true } {
    const provider = definition.provider
    if (isChatGPTProvider(provider)) return {
      id: "chatgpt", chatgpt: true, clientId: clientId ?? chatgptDynamicClientId,
      authorizationEndpoint: `${chatgptIssuer}/api/accounts/authorize`,
      tokenEndpoint: `${chatgptIssuer}/api/accounts/oauth/token`,
      identityScopes: chatgptScopes,
    }
    if (isApiKeyProvider(provider)) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey: true, connection: name })
    if (isLoginProvider(provider)) throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name, login: "connect" })
    return provider
  }

  async function tokenRequest(provider: ConnectionProvider & { chatgpt?: true }, parameters: Record<string, string>, signal?: AbortSignal, onDispatch?: () => void, onResponse?: () => void, connectionName?: string): Promise<ConnectionTokenResponse> {
    const clientId = await resolveValue(provider.clientId)
    const clientSecret = await resolveValue(provider.clientSecret)
    if (!clientId) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ problem: "client-id", provider: provider.id })
    const form = new URLSearchParams({ ...parameters, client_id: clientId })
    if (clientSecret) form.set("client_secret", clientSecret)
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
      // An infrastructure error may follow rotation. Only named OAuth rejections
      // prove that a ChatGPT grant was not changed; keep every other failure fenced.
      if (!provider.chatgpt || (response.status === 400 || response.status === 401)
        && error !== undefined && (error === "invalid_client" || chatgptTerminalRefreshErrors.has(error))) onResponse?.()
      throw error === "invalid_grant" || provider.chatgpt && error !== undefined && chatgptTerminalRefreshErrors.has(error)
        ? connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: connectionName ?? provider.id, problem: "rejected" })
        : connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ message: provider.chatgpt ? error === "invalid_client" ? "invalid_client" : undefined : error, problem: "token-request", provider: provider.id, status: response.status })
    }
    const token = v.safeParse(tokenResponseSchema, body)
    if (!token.success || provider.chatgpt && (
      !token.output.access_token || !token.output.refresh_token || !Number.isFinite(token.output.expires_in)
      || token.output.expires_in! <= 0 || token.output.token_type?.toLowerCase() !== "bearer"
    )) {
      // A malformed success may have rotated the grant without returning its replacement.
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

  /**
   * Refresh the stored token. `stale` is the access token the caller used. When the
   * stored token already differs, another request refreshed it first.
   */
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
        // Keep the lease if a rotated grant cannot be saved or quarantined durably.
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
      response = await tokenRequest(oauthProvider(definition, name, latest.chatgpt?.clientId), { grant_type: "refresh_token", refresh_token: latest.refreshToken! }, AbortSignal.timeout(REFRESH_WAIT_MS), () => { dispatched = true; onDispatch() }, () => { responded = true }, name)
    }
    catch (error) {
      if (!dispatched) throw error
      if (responded && isConnectionError(error, ["CONNECTIONS_PROVIDER_FAILED"])) {
        // A definite rejection leaves the refresh grant intact and retryable.
        onRejected()
        throw error
      }
      // A failed request can have rotated the provider grant before its response was lost.
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
      // Another isolate wrote a newer token. Use it.
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

  async function requireConnected(name: string): Promise<void> {
    const state = await (await getStore()).state.get(name)
    if (state?.status === "connected") return
    throw state?.status === "reauth_required"
      ? connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: name })
      : connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: name })
  }

  /**
   * Read the `fallback` key of an API key Connection. A sealed Server Env secret is unsealed.
   * The key must pass the same format check as a stored key.
   */
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

  /**
   * The `fallback` key for one request. It applies only when no key state was ever stored for the
   * Connection, or when the store cannot open. A stored key wins, and so does a revoke or a quarantine.
   * `connections` is the open store for activity, or `undefined` when the store cannot open.
   */
  async function fallbackFor(context: CallContext): Promise<{ connections?: ConnectionStore, key: string } | undefined> {
    const provider = context.definition.provider
    if (!isApiKeyProvider(provider) || !provider.fallback) return undefined
    // An approval binds to the credential it was requested with. A stored grant never uses the fallback.
    if (context.approved && context.approvedGrantId !== FALLBACK_GRANT) return undefined
    const connections = await getStore().catch(() => undefined)
    // A failed state read on an open store fails the request. It must not skip a revoke.
    if (connections && await connections.state.get(context.name) !== undefined) return undefined
    const key = await readFallbackKey(context.name, context.definition)
    return key === undefined ? undefined : { connections, key }
  }

  /** Dispatch one provider request with a credential and record whether a write reached the provider. */
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

  /** Reject a failed typed method response. Raw `fetch` returns every response. */
  async function checkResponse(providerRequest: ProviderRequest, response: Response): Promise<Response> {
    if (response.ok || providerRequest.action === "fetch") return response
    const message = await providerMessage(response)
    throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ action: providerRequest.action, message, status: response.status })
  }

  /** Send with the provider `fallback` key. Activity is recorded like an Env Bridge use while the store is open. */
  async function sendWithFallback(context: CallContext, providerRequest: ProviderRequest, init: SendInit, fallback: { connections?: ConnectionStore, key: string }): Promise<Response> {
    // Serialize fallback dispatch with token mutations. Recheck state after claiming the lease
    // so a revoke that completed while the fallback was resolving always wins.
    let owner: string | undefined
    if (fallback.connections?.refreshLeases) {
      owner = await claimMutationLease(context.name)
    }
    try {
      if (owner && await fallback.connections!.state.get(context.name) !== undefined) {
        throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: context.name })
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
    finally {
      if (owner) await fallback.connections!.refreshLeases!.release(context.name, owner).catch(() => undefined)
    }
  }

  /** Send one provider request with the Connection token inside an audited Env Bridge use. */
  async function send(context: CallContext, providerRequest: ProviderRequest, init: SendInit = {}): Promise<Response> {
    if (isLoginDefinition(context.definition)) {
      return await sendWithLogin(context, context.definition, providerRequest, init)
    }
    const fallback = await fallbackFor(context)
    if (fallback) return await sendWithFallback(context, providerRequest, init, fallback)
    const connections = await getStore()
    await requireConnected(context.name)
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
          // An API key has no refresh token. The admin replaces a rejected key.
          if (response.status === 401 && !isApiKeyProvider(context.definition.provider)) {
            // Cancellation may never settle; it must not block token refresh.
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
        throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: context.name })
      }
      throw error
    }
  }

  /**
   * Send with the in-memory token of a login provider. A `401` signs in again once and retries.
   * Activity is recorded like an Env Bridge use while the store is open.
   */
  async function sendWithLogin(context: CallContext, loaded: ConnectionLoginDefinition, providerRequest: ProviderRequest, init: SendInit): Promise<Response> {
    if (await logins.credentials(loaded.provider) === undefined) {
      throw connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: context.name, login: "credentials" })
    }
    const connections = await getStore().catch(() => undefined)
    const operationId = crypto.randomUUID()
    const record = async (outcome: EnvActivity["outcome"]) => {
      await connections?.access.append({ action: "use", actor: envActor(context.actor), id: crypto.randomUUID(), key: tokenKey(context.name), operation: providerRequest.action, operationId, outcome, revision: LOGIN_GRANT, timestamp: new Date(now()).toISOString(), traceId: context.options.traceId, invocationId: context.options.invocationId })
    }
    await record("started").catch(() => undefined)
    try {
      let token = await logins.token(context.name, loaded)
      let response = await dispatch(context, providerRequest, init, token)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        token = await logins.token(context.name, loaded, token.accessToken)
        response = await dispatch(context, providerRequest, init, token)
      }
      response = await checkResponse(providerRequest, response)
      await record("succeeded").catch(() => undefined)
      return response
    }
    catch (error) {
      await record("failed").catch(() => undefined)
      throw error
    }
  }

  /** The credential that an approval binds to: the stored grant, or the provider `fallback` key. */
  async function approvalGrant(context: CallContext): Promise<string> {
    if (isLoginProvider(context.definition.provider)) return LOGIN_GRANT
    if (await fallbackFor(context)) return FALLBACK_GRANT
    await requireConnected(context.name)
    const current = await (await getStore()).secrets.read(tokenKey(context.name))
    const token = current ? parseToken(current.value, context.name) : undefined
    if (!token?.grantId) {
      throw connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: context.name, problem: "approval" })
    }
    return token.grantId
  }

  /** Apply policy, dry run, and approval, then send. Returns `undefined` when dry run skips a write. */
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
      return { actor, definition: loaded, inherited, name, options, transport: createConnectionTransport(name, loaded, request, scheduler) }
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

  async function inspect(name: string): Promise<ConnectionInspection> {
    const loaded = await definition(name)
    // A login Connection is inspected without the store. It is connected while its credentials resolve,
    // because each request signs in when it needs to. A failed sign-in fails that request.
    if (isLoginDefinition(loaded)) {
      const token = logins.latest(name)
      const declared = [...(loaded.scopes ?? [])]
      const credentials = await logins.credentials(loaded.provider).catch(() => undefined)
      return {
        account: token?.account,
        actions: connectionActions(loaded),
        credential: "oauth2",
        ...(loaded.provider.mcp ? { mcp: loaded.provider.mcp } : {}),
        name,
        provider: loaded.provider.id,
        refreshedAt: token?.refreshedAt,
        scopes: { declared, granted: token?.scopes ?? [], missing: token ? declared.filter(scope => !token.scopes.includes(scope)) : declared },
        status: credentials === undefined ? "disconnected" : "connected",
      }
    }
    const provider = loaded.provider
    const apiKeyProvider = isApiKeyProvider(provider)
    const hasFallback = isApiKeyProvider(provider) && provider.fallback !== undefined
    let connections: ConnectionStore | undefined
    try {
      connections = await getStore()
    }
    catch (error) {
      // The fallback key works without the store, so inspection must too.
      if (!hasFallback) throw error
    }
    const state = await connections?.state.get(name)
    const declared = isChatGPTProvider(provider) ? [...chatgptScopes] : [...(loaded.scopes ?? [])]
    const granted = state?.scopes ?? []
    // A failing fallback means no key here. The request that uses it reports the error.
    const fallback = hasFallback && state === undefined && await readFallbackKey(name, loaded).catch(() => undefined) !== undefined
    const keySource = fallback ? "fallback" : apiKeyProvider && state?.status === "connected" ? "stored" : undefined
    return {
      account: state?.accountId ? { id: state.accountId, email: state.accountEmail } : undefined,
      actions: connectionActions(loaded),
      connectedAt: state?.connectedAt,
      ...(isChatGPTProvider(provider) ? {
        expiresAt: state?.status === "connected" && state.chatgpt?.expiresAt ? new Date(state.chatgpt.expiresAt).toISOString() : undefined,
        chatgpt: { clientId: state?.chatgpt?.clientId, hostId: await hostId(), plan: state?.status === "connected" && chatgptScopes.every(scope => granted.includes(scope)) ? "enabled" as const : "disabled" as const },
      } : {}),
      credential: apiKeyProvider ? "api-key" : isChatGPTProvider(provider) ? "chatgpt" : "oauth2",
      ...(loaded.provider.mcp ? { mcp: loaded.provider.mcp } : {}),
      ...(keySource ? { keySource } : {}),
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

  async function authorize(input: { actor?: string, name: string, redirectUri: string }): Promise<{ state: string, url: string }> {
    const loaded = await definition(input.name)
    const chatgpt = isChatGPTProvider(loaded.provider)
    const connections = await getStore()
    const registration = chatgpt ? await connections.state.get(input.name) : undefined
    const provider = oauthProvider(loaded, input.name, registration?.chatgpt?.clientId)
    const clientId = await resolveValue(provider.clientId)
    if (!clientId) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ problem: "client-id", provider: provider.id })
    const redirect = new URL(input.redirectUri)
    if (chatgpt) assertChatGPTCallback(input.redirectUri)
    else if (redirect.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "redirect-uri" })
    }
    const state = randomToken()
    const verifier = randomToken()
    const nonce = chatgpt ? randomToken() : undefined
    const host = chatgpt ? await hostId() : undefined
    await connections.authorizations.put({
      actor: input.actor ?? "user:local",
      expiresAt: now() + AUTHORIZATION_TTL_MS,
      name: input.name,
      redirectUri: redirect.toString(), state, verifier,
      ...(nonce ? { chatgpt: { clientId, nonce, subject: registration?.accountId } } : {}),
    })
    const url = new URL(provider.authorizationEndpoint)
    const scopes = [...new Set([...(provider.identityScopes ?? []), ...(loaded.scopes ?? [])])]
    const authorizationParams = Object.hasOwn(provider, "authorizationParams") ? provider.authorizationParams : undefined
    for (const [parameter, value] of Object.entries({
      ...authorizationParams,
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
    return { state, url: url.toString() }
  }

  async function complete(input: ConnectionCallback): Promise<ConnectionInspection> {
    const connections = await getStore()
    // Taking the state consumes it, so a rejected callback cannot be replayed.
    const authorization = await connections.authorizations.take(input.state)
    if (!authorization || authorization.expiresAt <= now()) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "authorization-expired" })
    if (authorization.actor !== (input.actor ?? "user:local")) throw connectionsErrorDiagnostics.CONNECTIONS_FORBIDDEN({ problem: "authorization-actor" })
    if (input.error === "access_denied") throw connectionsErrorDiagnostics.CONNECTIONS_AUTHORIZATION_CANCELLED()
    if (input.error) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "token-request" })
    if (!input.code) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "body" })
    const name = authorization.name
    const loaded = await definition(name)
    const chatgpt = isChatGPTProvider(loaded.provider)
    if (chatgpt && !authorization.chatgpt) throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_REGISTRATION()
    const clientId = authorization.chatgpt ? chatgptCallbackClient(authorization.chatgpt.clientId, input.clientId) : undefined
    const provider = oauthProvider(loaded, name, clientId)
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
      // A successful exchange may already have replaced the provider grant. Keep
      // the mutation fenced until the replacement token and state are durable.
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
      // Bind the account check to the same token revision used by the conditional write.
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
      if (chatgpt && clientId && response.id_token) token.chatgpt = {
        clientId, idToken: response.id_token,
        earliestRefreshAt: response.earliest_refresh_at === undefined ? undefined : response.earliest_refresh_at * 1000,
      }
      token.accountId = account?.id
      token.grantId = randomToken()
      // Quarantine the Connection if its new grant cannot be saved durably.
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

  async function revoke(input: { actor?: string, name: string }): Promise<ConnectionInspection> {
    const loaded = await definition(input.name)
    // A login Connection has no stored grant. Revoking it drops the tokens, and the next request signs in again.
    if (isLoginProvider(loaded.provider)) {
      logins.forget(input.name)
      return await inspect(input.name)
    }
    const connections = await getStore()
    const key = tokenKey(input.name)
    const actor = input.actor ?? "user:local"
    // ViteHub cannot revoke an API key at the provider. Revocation deletes the stored key.
    const revocationEndpoint = isChatGPTProvider(loaded.provider) ? await chatgptRevocationEndpoint(request) : isApiKeyProvider(loaded.provider) || isLoginProvider(loaded.provider) ? undefined : loaded.provider.revocationEndpoint
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
            // A lost response can leave a grant-wide revoke running at the provider.
            releaseLease = false
            const response = await request(revocationEndpoint, {
              body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken, ...(token.chatgpt ? { client_id: token.chatgpt.clientId, token_type_hint: "refresh_token" } : {}) }),
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
          // Keep the mutation lease until the revoked marker and metadata are durable.
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
      // A check failure message could contain the key, so ViteHub keeps only a Connections code that does not contain it.
      let preserve = false
      try {
        if (isConnectionError(error)) {
          const why = Reflect.get(error, "why")
          const code = Reflect.get(error, "code")
          preserve = typeof why === "string" && typeof code === "string" && !why.includes(key) && !code.includes(key)
        }
      }
      catch {
        // Malformed or accessor-backed provider errors are sanitized below.
      }
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

  async function setKey(input: { actor?: string, key: string, name: string }): Promise<ConnectionInspection> {
    const name = input.name
    const loaded = await definition(name)
    if (isLoginProvider(loaded.provider)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ connection: name, problem: "login-key" })
    }
    if (!isApiKeyProvider(loaded.provider)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ connection: name, problem: "oauth-key" })
    }
    if (!API_KEY_PATTERN.test(input.key)) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ problem: "api-key-format" })
    }
    const actor = input.actor ?? "user:local"
    envActor(actor)
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

  async function approve(input: { actor?: string, id: string }): Promise<{ approval: ConnectionApproval, result?: unknown }> {
    const connections = await getStore()
    await connections.approvals.recover(new Date(now()).toISOString())
    const decidedAt = new Date(now()).toISOString()
    const executionExpiresAt = new Date(now() + APPROVAL_EXECUTION_TTL_MS).toISOString()
    const approval = await connections.approvals.transition(input.id, "pending", "approved", {
      decidedAt,
      decidedBy: input.actor ?? "user:local",
      executionExpiresAt,
    })
    if (!approval) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_REQUEST({ approval: input.id, problem: "not-pending" })
    const leaseAbort = new AbortController()
    const signal = AbortSignal.any([
      AbortSignal.timeout(APPROVAL_EXECUTION_TTL_MS),
      leaseAbort.signal,
    ])
    // Keep the lease alive until the provider settles, even if it ignores abort.
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
        transport: createConnectionTransport(approval.name, loaded, request, scheduler),
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

  async function deny(input: { actor?: string, id: string }): Promise<ConnectionApproval> {
    const approval = await (await getStore()).approvals.transition(input.id, "pending", "denied", {
      decidedAt: new Date(now()).toISOString(),
      decidedBy: input.actor ?? "user:local",
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
      // Move refresh ownership before the protected file leaves this host.
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
    // Imported identity can be expired. Verify its signature at its signed issue time, then renew the session.
    let issuedAt: number
    try {
      const claims = decodeJwt(credential.id_token)
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat * 1000 > now() + 5000) throw new Error("Invalid issue time")
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
      const response = await tokenRequest(oauthProvider(loaded, input.name, credential.client_id), {
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
    setKey,
  }
  registerChatGPTCredentialUse(runtime, useChatGPT)
  registerChatGPTTransfers(runtime, { export: exportChatGPT, import: importChatGPT, models: chatgptModels })
  return runtime
}
