import { connectionEnvAccess } from "@vite-hub/env/internal/connections"
import * as v from "valibot"

import { createConnectionTransport } from "./transport.ts"
import { isApiKeyProvider } from "./api-key.ts"
import { ConnectionError, isConnectionError, isEnvBridgeError } from "./errors.ts"
import { isConnectionDefinition } from "./definition.ts"
import { CONNECTION_NAME_MAX_LENGTH, isConnectionReadMethod } from "./types.ts"
import { callerActor, decide, envActor } from "./policy.ts"
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

interface StoredToken {
  grantId?: string
  accountId?: string
  accessToken: string
  expiresAt?: number
  refreshToken?: string
  scopes: string[]
  tokenType: string
}

export interface ConnectionsRuntimeOptions {
  /** Connection definitions by name, or loaders that import them. */
  definitions: Readonly<Record<string, ConnectionDefinition | (() => Promise<unknown>)>>
  store: ConnectionStore | (() => ConnectionStore | Promise<ConnectionStore>)
  fetch?: typeof fetch
  now?: () => number
}

interface CallContext {
  transport: ReturnType<typeof createConnectionTransport>
  actor: string
  approved?: boolean
  approvedGrantId?: string
  definition: ConnectionDefinition
  name: string
  options: UseConnectionOptions
  providerExecution?: { dispatched: boolean, rejected: boolean }
}

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
  complete: (input: { actor?: string, code: string, state: string }) => Promise<ConnectionInspection>
  definition: (name: string) => Promise<ConnectionDefinition>
  deny: (input: { actor?: string, id: string }) => Promise<ConnectionApproval>
  inspect: (name: string) => Promise<ConnectionInspection>
  list: () => Promise<ConnectionInspection[]>
  revoke: (input: { actor?: string, name: string }) => Promise<ConnectionInspection>
  /** Store the key of an API key Connection. The provider `verify` check runs first. */
  setKey: (input: { actor?: string, key: string, name: string }) => Promise<ConnectionInspection>
}

const storedTokenSchema = v.object({
  grantId: v.optional(v.string()),
  accountId: v.optional(v.string()),
  accessToken: v.string(),
  expiresAt: v.optional(v.number()),
  refreshToken: v.optional(v.string()),
  scopes: v.array(v.string()),
  tokenType: v.string(),
})
const tokenResponseSchema = v.object({
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
const approvalInputSchema = v.variant("kind", [
  v.object({ grantId: v.optional(v.string()), input: v.unknown(), kind: v.literal("method") }),
  v.object({ grantId: v.optional(v.string()), body: v.optional(v.string()), headers: v.optional(v.record(v.string(), v.string())), kind: v.literal("fetch"), method: v.string(), redirect: v.optional(v.picklist(["error", "follow", "manual"])), url: v.string() }),
])

async function resolveValue(value: ConnectionValue | undefined): Promise<string | undefined> {
  return v.is(v.string(), value) || value === undefined ? value : await value()
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
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
    throw new ConnectionError("invalid", `Stored token for Connection "${name}" is invalid.`, { details: { connection: name } })
  }
  const token = v.safeParse(storedTokenSchema, parsed)
  if (!token.success) {
    throw new ConnectionError("reauth_required", `Connection "${name}" is not connected. Run \`vitehub connections connect ${name}\`.`, { details: { connection: name } })
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
    throw new ConnectionError("provider", "Provider returned invalid JSON.")
  }
}

/** Create the Connections runtime. Applications normally use `useConnection()` instead. */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions): ConnectionsRuntime {
  const request = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init))
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
  const definitions = new Map<string, Promise<ConnectionDefinition | undefined>>()

  const getStore = () => (store ??= Promise.resolve(v.is(v.function(), options.store) ? options.store() : options.store).catch((error: unknown) => {
    store = undefined
    throw error
  }))

  async function loadDefinition(name: string): Promise<ConnectionDefinition | undefined> {
    const entry = Object.hasOwn(options.definitions, name) ? options.definitions[name] : undefined
    if (!entry) return undefined
    if (isConnectionDefinition(entry)) return entry
    if (!v.is(v.function(), entry)) return undefined
    let loaded = definitions.get(name)
    if (!loaded) {
      loaded = entry().then((module) => {
        if (isConnectionDefinition(module)) return module
        const parsedModule = v.safeParse(v.object({ default: v.unknown() }), module)
        return parsedModule.success && isConnectionDefinition(parsedModule.output.default) ? parsedModule.output.default : undefined
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
    if (name.length > CONNECTION_NAME_MAX_LENGTH) {
      throw new ConnectionError("invalid", `Connection names must not exceed ${CONNECTION_NAME_MAX_LENGTH} characters so their Env keys fit the 512-character limit.`, { details: { connection: name } })
    }
    const loaded = await loadDefinition(name)
    if (!loaded) throw new ConnectionError("invalid", `No Connection Definition was discovered for "${name}".`, { details: { connection: name } })
    return loaded
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

  function oauthProvider(definition: ConnectionDefinition, name: string): ConnectionProvider {
    const provider = definition.provider
    if (isApiKeyProvider(provider)) {
      throw new ConnectionError("invalid", `Connection "${name}" uses an API key. Set it with \`vitehub connections set-key ${name}\` or in the Console.`, { details: { connection: name } })
    }
    return provider
  }

  async function tokenRequest(provider: ConnectionProvider, parameters: Record<string, string>, signal?: AbortSignal, onDispatch?: () => void, onResponse?: () => void): Promise<ConnectionTokenResponse> {
    const clientId = await resolveValue(provider.clientId)
    const clientSecret = await resolveValue(provider.clientSecret)
    if (!clientId) throw new ConnectionError("invalid", `Provider "${provider.id}" has no client id.`)
    const form = new URLSearchParams({ ...parameters, client_id: clientId })
    if (clientSecret) form.set("client_secret", clientSecret)
    onDispatch?.()
    const response = await request(provider.tokenEndpoint, {
      body: form,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal,
    })
    const body: unknown = await response.json().catch(() => undefined)
    const parsedError = v.safeParse(v.object({ error: v.string() }), body)
    const error = parsedError.success ? parsedError.output.error : undefined
    if (!response.ok || error) {
      onResponse?.()
      throw new ConnectionError(error === "invalid_grant" ? "reauth_required" : "provider", `Provider "${provider.id}" rejected the token request${error ? ` (${error})` : ""}.`, {
        details: { status: response.status },
      })
    }
    const token = v.safeParse(tokenResponseSchema, body)
    if (!token.success) {
      // A malformed success may have rotated the grant without returning its replacement.
      throw new ConnectionError("provider", `Provider "${provider.id}" returned no access token.`)
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
    return token.expiresAt !== undefined && token.expiresAt - now() < REFRESH_WINDOW_MS
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
    if (!current) throw new ConnectionError("reauth_required", `Connection "${name}" is not connected.`, { details: { connection: name } })
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
      if (!stored) throw new ConnectionError("reauth_required", `Connection "${name}" is not connected.`, { details: { connection: name } })
      if (!stored.revision) throw new ConnectionError("invalid", "The Connection secret store must return token revisions.")
      const latest = parseToken(stored.value, name)
      if (latest.accessToken !== stale && !expiresSoon(latest)) return latest
      if (!force && !expiresSoon(latest)) return latest
      if (!latest.refreshToken) {
        if (!await setStatus(name, { status: "reauth_required" }, stored.revision)) return await readCurrentToken(name)
        throw new ConnectionError("reauth_required", `Connection "${name}" has no refresh token. Connect it again.`, { details: { connection: name } })
      }
      if (!connections.refreshLeases) throw new ConnectionError("invalid", "The Connection store must provide atomic token mutation leases.")
      const lease = await connections.refreshLeases.claim({ expiresAt: now() + REFRESH_LEASE_MS, name, now: now(), owner, revision: stored.revision })
      if (lease === "expired") {
        await setStatus(name, { status: "reauth_required" }, stored.revision)
        throw unresolvedMutation(name)
      }
      if (lease === "busy") {
        if (Date.now() >= deadline) throw new ConnectionError("provider", `Connection "${name}" has a token mutation in progress. Try again.`, { details: { connection: name } })
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
      response = await tokenRequest(oauthProvider(definition, name), { grant_type: "refresh_token", refresh_token: latest.refreshToken! }, AbortSignal.timeout(REFRESH_WAIT_MS), () => { dispatched = true; onDispatch() }, () => { responded = true })
    }
    catch (error) {
      if (!dispatched) throw error
      if (responded && isConnectionError(error) && error.reason === "provider") {
        // A definite rejection leaves the refresh grant intact and retryable.
        onRejected()
        throw error
      }
      // A failed request can have rotated the provider grant before its response was lost.
      if (!await setStatus(name, { status: "reauth_required" }, tokenRevision)) return await readCurrentToken(name)
      if (isConnectionError(error) && error.reason === "reauth_required") {
        throw new ConnectionError("reauth_required", `Connection "${name}" must be connected again. Run \`vitehub connections connect ${name}\`.`, { details: { connection: name } })
      }
      throw error
    }
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
      if (!current) throw new ConnectionError("reauth_required", `Connection "${name}" is not connected.`, { details: { connection: name } })
      return parseToken(current.value, name)
    }
    if (!await setStatus(name, { refreshedAt: new Date(now()).toISOString(), scopes: next.scopes, status: "connected" }, revision)) return await readCurrentToken(name)
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
    const message = state?.status === "reauth_required"
      ? `Connection "${name}" must be connected again. Run \`vitehub connections connect ${name}\`.`
      : `Connection "${name}" is not connected. Run \`vitehub connections connect ${name}\`.`
    throw new ConnectionError("reauth_required", message, { details: { connection: name } })
  }

  /** Send one provider request with the Connection token inside an audited Env Bridge use. */
  async function send(context: CallContext, providerRequest: ProviderRequest, init: { headers?: Record<string, string>, redirect?: RequestInit["redirect"], signal?: AbortSignal } = {}): Promise<Response> {
    const connections = await getStore()
    await requireConnected(context.name)
    let failure: unknown
    try {
      return await connections.bridge.use(envContext(connections, context.name, "use", context.actor, context.options), tokenKey(context.name), providerRequest.action, async (secret) => {
        try {
          let token = parseToken(secret.unseal(), context.name)
          if (context.approved && (!context.approvedGrantId || token.grantId !== context.approvedGrantId)) {
            throw new ConnectionError("invalid", "Approval belongs to a previous Connection grant.")
          }
          if (expiresSoon(token)) token = await refresh(context.name, context.definition, token.accessToken, false)
          const call = (current: StoredToken) => {
            if (context.approved && (!context.approvedGrantId || current.grantId !== context.approvedGrantId)) {
              throw new ConnectionError("invalid", "Approval belongs to a previous Connection grant.")
            }
            if (providerRequest.write && context.providerExecution) {
              context.providerExecution.dispatched = true
              context.providerExecution.rejected = false
            }
            const providerInit = {
              body: providerRequest.body,
              json: providerRequest.json,
              headers: init.headers,
              method: providerRequest.method,
              redirect: init.redirect,
              signal: init.signal,
            }
            const dispatch = context.transport.send(providerRequest.url, current, providerInit)
            return dispatch.then(response => {
              if (providerRequest.write && context.providerExecution) {
                context.providerExecution.rejected = response.status >= 400 && response.status < 500 && response.status !== 408
              }
              return response
            })
          }
          let response = await call(token)
          // An API key has no refresh token. The admin replaces a rejected key.
          if (response.status === 401 && !isApiKeyProvider(context.definition.provider)) {
            token = await refresh(context.name, context.definition, token.accessToken, true)
            response = await call(token)
          }
          if (!response.ok && providerRequest.action !== "fetch") {
            const message = await providerMessage(response)
            throw new ConnectionError("provider", `Provider rejected ${providerRequest.action} with ${response.status}${message ? `: ${message}` : "."}`, {
              details: { action: providerRequest.action, connection: context.name, status: response.status },
            })
          }
          return response
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
        throw new ConnectionError("reauth_required", `Connection "${context.name}" is not connected.`, { details: { connection: context.name } })
      }
      throw error
    }
  }

  /** Apply policy, dry run, and approval, then send. Returns `undefined` when dry run skips a write. */
  async function governed(context: CallContext, providerRequest: ProviderRequest, approvalInput: ApprovalInput, init: { headers?: Record<string, string>, redirect?: RequestInit["redirect"], signal?: AbortSignal } = {}): Promise<Response | undefined> {
    envActor(context.actor)
    const decision = decide({
      action: providerRequest.action,
      actor: context.actor,
      approved: context.approved,
      definition: context.definition,
      highRisk: providerRequest.highRisk,
      write: providerRequest.write,
    })
    if (decision === "deny") {
      await recordDenied(context.name, context.actor, providerRequest.action, context.options)
      throw new ConnectionError("denied", `Actor "${context.actor}" may not call ${providerRequest.action} on Connection "${context.name}".`, {
        details: { action: providerRequest.action, connection: context.name },
      })
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
        await recordDenied(context.name, context.actor, providerRequest.action, context.options)
        throw new ConnectionError("denied", `Connection "${context.name}" requires immediate access for ${providerRequest.action}. Set approve: false on the actor's access rule.`, {
          details: { action: providerRequest.action, connection: context.name },
        })
      }
      await requireConnected(context.name)
      const current = await (await getStore()).secrets.read(tokenKey(context.name))
      const token = current ? parseToken(current.value, context.name) : undefined
      if (!token?.grantId) {
        throw new ConnectionError("reauth_required", `Connection "${context.name}" must be connected again before requesting approval.`, { details: { connection: context.name } })
      }
      const approval: ConnectionApproval = {
        action: providerRequest.action,
        actor: context.actor,
        createdAt: new Date(now()).toISOString(),
        id: `approval_${randomToken().slice(0, 20)}`,
        input: { ...approvalInput, grantId: token.grantId },
        name: context.name,
        status: "pending",
        traceId: context.options.traceId,
        invocationId: context.options.invocationId,
      }
      await (await getStore()).approvals.create(approval)
      throw new ConnectionError("approval_required", `Approval is required for ${providerRequest.action} on Connection "${context.name}". Request: ${approval.id}.`, {
        details: { action: providerRequest.action, connection: context.name },
        requestId: approval.id,
      })
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
      throw new ConnectionError("invalid", "Connection fetch accepts only a string body.")
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
      const loaded = await definition(name)
      return { actor, definition: loaded, name, options, transport: createConnectionTransport(name, loaded, request) }
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
    const state = await (await getStore()).state.get(name)
    const declared = [...(loaded.scopes ?? [])]
    const granted = state?.scopes ?? []
    return {
      account: state?.accountId ? { id: state.accountId, email: state.accountEmail } : undefined,
      actions: connectionActions(loaded),
      connectedAt: state?.connectedAt,
      credential: isApiKeyProvider(loaded.provider) ? "api-key" : "oauth2",
      name,
      provider: loaded.provider.id,
      refreshedAt: state?.refreshedAt,
      scopes: {
        declared,
        granted,
        missing: state?.status === "connected" ? declared.filter(scope => !granted.includes(scope)) : declared,
      },
      status: state?.status ?? "disconnected",
    }
  }

  async function authorize(input: { actor?: string, name: string, redirectUri: string }): Promise<{ state: string, url: string }> {
    const loaded = await definition(input.name)
    const provider = oauthProvider(loaded, input.name)
    const clientId = await resolveValue(provider.clientId)
    if (!clientId) throw new ConnectionError("invalid", `Provider "${provider.id}" has no client id.`)
    const redirect = new URL(input.redirectUri)
    if (redirect.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
      throw new ConnectionError("invalid", "The redirect URI must use HTTPS or a loopback address.")
    }
    const state = randomToken()
    const verifier = randomToken()
    await (await getStore()).authorizations.put({
      actor: input.actor ?? "user:local",
      expiresAt: now() + AUTHORIZATION_TTL_MS,
      name: input.name,
      redirectUri: redirect.toString(),
      state,
      verifier,
    })
    const url = new URL(provider.authorizationEndpoint)
    const scopes = [...new Set([...(provider.identityScopes ?? []), ...(loaded.scopes ?? [])])]
    for (const [parameter, value] of Object.entries({
      ...provider.authorizationParams,
      client_id: clientId,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: "S256",
      redirect_uri: redirect.toString(),
      response_type: "code",
      scope: scopes.join(" "),
      state,
    })) url.searchParams.set(parameter, value)
    return { state, url: url.toString() }
  }

  async function complete(input: { actor?: string, code: string, state: string }): Promise<ConnectionInspection> {
    const connections = await getStore()
    // Taking the state consumes it, so a rejected callback cannot be replayed.
    const authorization = await connections.authorizations.take(input.state)
    if (!authorization || authorization.expiresAt < now()) throw new ConnectionError("invalid", "The authorization request is unknown or expired. Start the connection again.")
    if (authorization.actor !== (input.actor ?? "user:local")) throw new ConnectionError("denied", "Another user started this authorization request. Start the connection again.")
    const name = authorization.name
    const loaded = await definition(name)
    const provider = oauthProvider(loaded, name)
    const owner = await claimMutationLease(name)
    let releaseLease = true
    let quarantine = false
    try {
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
      let account: ReturnType<typeof provider.account>
      try {
        account = provider.account(response)
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
        throw new ConnectionError("invalid", account ? `Connection "${name}" belongs to another account. Confirm the provider outcome and repair the mutation lease before revoking or connecting again.` : `Provider "${provider.id}" did not identify the account. The existing Connection was quarantined.`, { details: { connection: name } })
      }
      const token = toStoredToken(response, previous?.success ? previous.output : undefined, [
        ...new Set([...(provider.identityScopes ?? []), ...(loaded.scopes ?? [])]),
      ])
      token.accountId = account?.id
      token.grantId = randomToken()
      // Quarantine the Connection if its new grant cannot be saved durably.
      releaseLease = false
      quarantine = true
      const replacement = await connections.bridge.replace(envContext(connections, name, "replace", authorization.actor), { expectedRevision: current?.revision ?? null, key, value: JSON.stringify(token) })
      const timestamp = new Date(now()).toISOString()
      const persisted = await connections.state.putForToken({
        accountEmail: account?.email,
        accountId: account?.id,
        connectedAt: timestamp,
        name,
        refreshedAt: timestamp,
        scopes: token.scopes,
        status: "connected",
        updatedAt: timestamp,
      }, replacement.revision)
      if (!persisted) throw new ConnectionError("invalid", "The Connection token changed during authorization.")
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

  function unresolvedMutation(name: string): ConnectionError {
    return new ConnectionError("reauth_required", `Connection "${name}" has an unconfirmed token mutation. Confirm the provider outcome and repair its mutation lease before connecting again.`, { details: { connection: name } })
  }

  async function claimMutationLease(name: string): Promise<string> {
    const connections = await getStore()
    if (!connections.refreshLeases) throw new ConnectionError("invalid", "The Connection store must provide atomic token mutation leases.")
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
      if (Date.now() >= deadline) throw new ConnectionError("provider", `Connection "${name}" has a token mutation in progress. Try again.`, { details: { connection: name } })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  async function revoke(input: { actor?: string, name: string }): Promise<ConnectionInspection> {
    const loaded = await definition(input.name)
    const connections = await getStore()
    const key = tokenKey(input.name)
    const actor = input.actor ?? "user:local"
    // ViteHub cannot revoke an API key at the provider. Revocation deletes the stored key.
    const revocationEndpoint = isApiKeyProvider(loaded.provider) ? undefined : loaded.provider.revocationEndpoint
    const owner = await claimMutationLease(input.name)
    let releaseLease = true
    let providerFailure: ConnectionError | undefined
    let providerRevoked = false
    let leasedRevision: string | undefined
    try {
      const stored = await connections.secrets.inspect(key)
      let revision: string | null = null
      if (stored) {
        if (!revocationEndpoint && !isApiKeyProvider(loaded.provider)) {
          throw new ConnectionError("invalid", `Provider "${loaded.provider.id}" does not support token revocation.`, {
            details: { connection: input.name },
          })
        }
        revision = await connections.bridge.use(envContext(connections, input.name, "use", actor), key, "revoke", async (secret, metadata) => {
          if (!metadata?.revision) throw new ConnectionError("invalid", "Connection revocation requires the Env Bridge to provide the leased token revision.")
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
              body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken }),
              headers: { "content-type": "application/x-www-form-urlencoded" },
              method: "POST",
              signal: AbortSignal.timeout(REFRESH_WAIT_MS),
            })
            if (response.ok) providerRevoked = true
            await response.arrayBuffer()
            if (!response.ok) {
              providerFailure = new ConnectionError("provider", `Provider rejected revoke with ${response.status}.`, {
                details: { connection: input.name, status: response.status },
              })
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
      if (!await setStatus(input.name, { status: "revoked" }, revision)) throw new ConnectionError("invalid", "The Connection token changed during revocation.")
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
      // A check failure message could contain the key, so only Connection errors pass through.
      if (isConnectionError(error)) throw error
      throw new ConnectionError("provider", `Provider "${provider.id}" could not verify the key.`, { details: { connection: name } })
    }
    const verification = v.safeParse(apiKeyVerificationSchema, result)
    if (!verification.success) throw new ConnectionError("invalid", `The verify check of provider "${provider.id}" must return a boolean or { account }.`, { details: { connection: name } })
    if (verification.output === false) throw new ConnectionError("invalid", `Provider "${provider.id}" rejected the key.`, { details: { connection: name } })
    if (verification.output === true || !verification.output.account) return undefined
    const account: ConnectionAccount = { id: verification.output.account.id }
    if (verification.output.account.email !== undefined) account.email = verification.output.account.email
    return account
  }

  async function setKey(input: { actor?: string, key: string, name: string }): Promise<ConnectionInspection> {
    const name = input.name
    const loaded = await definition(name)
    if (!isApiKeyProvider(loaded.provider)) {
      throw new ConnectionError("invalid", `Connection "${name}" uses OAuth. Connect it with \`vitehub connections connect ${name}\`.`, { details: { connection: name } })
    }
    if (!API_KEY_PATTERN.test(input.key)) {
      throw new ConnectionError("invalid", "An API key must contain 1 to 8192 visible ASCII characters.", { details: { connection: name } })
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
      if (!persisted) throw new ConnectionError("invalid", "The Connection key changed while it was set.", { details: { connection: name } })
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
    return await Promise.all(Object.keys(options.definitions).sort().map(name => inspect(name)))
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
    if (!approval) throw new ConnectionError("invalid", `Approval "${input.id}" is not pending.`)
    const leaseAbort = new AbortController()
    const signal = AbortSignal.any([
      AbortSignal.timeout(APPROVAL_EXECUTION_TTL_MS),
      leaseAbort.signal,
    ])
    // Keep the lease alive until the provider settles, even if it ignores abort.
    const heartbeat = setInterval(() => {
      void connections.approvals
        .renew(input.id, new Date(now() + APPROVAL_EXECUTION_TTL_MS).toISOString())
        .then(active => { if (!active) leaseAbort.abort(new ConnectionError("invalid", "Approval execution lease was lost.")) })
        .catch((error: unknown) => leaseAbort.abort(error))
    }, APPROVAL_EXECUTION_TTL_MS / 3)
    const providerExecution = { dispatched: false, rejected: false }
    try {
      const stored = v.parse(approvalInputSchema, approval.input)
      const loaded = await definition(approval.name)
      const context: CallContext = {
        transport: createConnectionTransport(approval.name, loaded, request),
        actor: approval.actor,
        approved: true,
        approvedGrantId: stored.grantId,
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
      if (!executed) throw new ConnectionError("invalid", "Approval execution lease was lost.")
      const output: { approval: ConnectionApproval; result?: unknown } = {
        approval: executed,
      }
      if (result !== undefined) output.result = result
      return output
    }
    catch (error) {
      const uncertain = signal.aborted || (providerExecution.dispatched && !providerExecution.rejected)
      const failure = uncertain
        ? new ConnectionError("execution_unknown", "The provider may have completed this write. Check the provider before requesting another approval.", { details: { action: approval.action, connection: approval.name }, requestId: input.id })
        : error
      const code = isConnectionError(failure) ? failure.code : "CONNECTION_FAILED"
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
    if (!approval) throw new ConnectionError("invalid", `Approval "${input.id}" is not pending.`)
    return approval
  }

  return {
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
}
