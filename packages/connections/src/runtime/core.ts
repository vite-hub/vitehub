import { decideConnectionAccess } from "../access.ts"
import { connectionError, isConnectionError } from "../errors.ts"
import { matchesConnectionOrigin } from "../origins.ts"
import { createConnectionsStore } from "../store.ts"

import type { ConnectionsDatabase, ConnectionsStore, StoredGrant } from "../store.ts"
import type {
  ConnectionAccessDecision,
  ConnectionActivity,
  ConnectionActor,
  ConnectionDefinition,
  ConnectionDefinitionRegistry,
  ConnectionEffect,
  ConnectionOperation,
  ConnectionProviderContext,
  ConnectionRequest,
  ConnectionSkipped,
  ConnectionSummary,
  ConnectionTokenSet,
  ConnectionTrace,
} from "../types.ts"

export const CONNECTIONS_BASE_PATH = "/_vitehub/connections"
/** Refresh this long before the access token expires. */
const refreshSkewMs = 60_000
const leaseMs = 30_000
const leaseWaitMs = 5_000
const pendingTtlMs = 10 * 60_000

export interface ConnectionsRuntimeOptions {
  /** Base path of the connect and callback routes. Default: `/_vitehub/connections`. */
  basePath?: string
  database: () => ConnectionsDatabase | undefined
  /** Base64url or raw 32-byte key. Called with the current event. */
  encryptionKey: (event: unknown) => string | Uint8Array | undefined
  fetch?: typeof globalThis.fetch
  registry: ConnectionDefinitionRegistry
}

export interface ConnectionCallOptions {
  actor: ConnectionActor
  /**
   * Trusted server integration input, like `actor`. Set only after approval for this exact call and Operation.
   * Never forward an approval flag from tool input or an HTTP request. `deny` rules still apply.
   */
  approved?: boolean
  audit?: "all" | "changes"
  dryRun?: boolean
  event?: unknown
  trace?: ConnectionTrace
}

export interface ConnectionLifecycleOptions {
  actor: ConnectionActor
  event?: unknown
}

export interface ConnectionsRuntime {
  activity: (options: { before?: string, connection?: string, event?: unknown, limit?: number }) => Promise<ConnectionActivity[]>
  /** Completes the OAuth callback. `cookieState` must match the `state` query parameter. */
  callback: (input: { code?: string, cookieState?: string, error?: string, event?: unknown, name: string, state?: string }) => Promise<ConnectionSummary>
  call: <TInput, TOutput, TEffect extends ConnectionEffect>(
    name: string,
    operation: ConnectionOperation<TInput, TOutput, TEffect>,
    input: TInput,
    options: ConnectionCallOptions,
  ) => Promise<TOutput | ConnectionSkipped>
  decide: (name: string, actor: ConnectionActor, operation: { effect: ConnectionEffect, id: string }) => Promise<ConnectionAccessDecision>
  disconnect: (name: string, options: ConnectionLifecycleOptions) => Promise<ConnectionSummary>
  fetch: (name: string, url: string | URL, init: RequestInit | undefined, options: ConnectionCallOptions) => Promise<Response>
  inspect: (name: string, event?: unknown) => Promise<ConnectionSummary>
  list: (event?: unknown) => Promise<ConnectionSummary[]>
  names: () => string[]
  /** Opens a connect ticket. Returns the provider URL and the state for the cookie. */
  open: (input: { event?: unknown, name: string, ticket: string }) => Promise<{ authorizationUrl: string, state: string }>
  record: (activity: Omit<ConnectionActivity, "id" | "timestamp">, event?: unknown) => Promise<void>
  refresh: (name: string, options: ConnectionLifecycleOptions) => Promise<ConnectionSummary>
  /** Creates a single-use connect ticket. `origin` is the public origin of the app. */
  start: (name: string, options: ConnectionLifecycleOptions & { origin: string }) => Promise<{ expiresAt: string, url: string }>
}

function isDefinition(value: unknown): value is ConnectionDefinition {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry modules are loaded with dynamic import and are unknown values.
  return typeof value === "object" && value !== null && "provider" in value && typeof value.provider === "object"
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decodes a base64url or base64 key. */
export function decodeConnectionsKey(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  try {
    return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")), char => char.charCodeAt(0))
  }
  catch {
    throw connectionError("not_configured")
  }
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

function requestUrl(request: ConnectionRequest): URL {
  const url = new URL(request.url)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item))
    else url.searchParams.set(key, String(value))
  }
  return url
}

function target(url: URL): string {
  return `${url.host}${url.pathname}`
}

function errorCode(error: unknown): string {
  return isConnectionError(error) ? error.code : "CONNECTIONS_FAILED"
}

function errorStatus(error: unknown): number | undefined {
  if (!isConnectionError(error)) return
  const status = error.details?.status
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Error details are an unknown record.
  return typeof status === "number" ? status : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Host-independent Connections runtime. The generated module supplies registry, database, and key. */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions): ConnectionsRuntime {
  const basePath = options.basePath ?? CONNECTIONS_BASE_PATH
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const definitions = new Map<string, Promise<ConnectionDefinition>>()
  const stores = new Map<string, ConnectionsStore>()

  function names(): string[] {
    return Object.keys(options.registry).sort()
  }

  function definition(name: string): Promise<ConnectionDefinition> {
    let loaded = definitions.get(name)
    if (!loaded) {
      const entry = options.registry[name]
      if (!entry) return Promise.reject(connectionError("not_found", { connection: name }))
      loaded = entry().then((module) => {
        if (isDefinition(module)) return module
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry modules are loaded with dynamic import and are unknown values.
        if (typeof module === "object" && module !== null && "default" in module && isDefinition(module.default)) return module.default
        throw connectionError("not_found", { connection: name })
      })
      loaded.catch(() => definitions.delete(name))
      definitions.set(name, loaded)
    }
    return loaded
  }

  function store(event: unknown): ConnectionsStore {
    const db = options.database()
    const raw = options.encryptionKey(event)
    if (!db || raw === undefined || raw === "") throw connectionError("not_configured")
    const key = decodeConnectionsKey(raw)
    if (key.byteLength !== 32) throw connectionError("not_configured")
    const cacheKey = base64url(key)
    let value = stores.get(cacheKey)
    if (!value) {
      value = createConnectionsStore({ db, encryptionKey: key })
      stores.set(cacheKey, value)
    }
    return value
  }

  function providerContext(event: unknown): ConnectionProviderContext {
    return { event, fetch: fetcher }
  }

  async function record(activity: Omit<ConnectionActivity, "id" | "timestamp">, event?: unknown): Promise<void> {
    await store(event).append({ ...activity, id: crypto.randomUUID(), timestamp: new Date().toISOString() })
  }

  async function recordQuietly(activity: Omit<ConnectionActivity, "id" | "timestamp">, event: unknown): Promise<void> {
    // Audit failures after a provider call must not change the call result.
    await record(activity, event).catch(() => undefined)
  }

  function summary(name: string, value: ConnectionDefinition, grant: StoredGrant | undefined): ConnectionSummary {
    const base = {
      access: value.access ?? {},
      name,
      origins: value.provider.origins,
      provider: value.provider.id,
      ...(value.description ? { description: value.description } : {}),
    }
    if (!grant) return { ...base, scopes: value.provider.scopes, status: "disconnected" }
    const current = grant.keyMatches && grant.provider === value.provider.id
    return {
      ...base,
      connectedAt: grant.connectedAt,
      scopes: grant.scopes,
      status: current ? grant.status : "needs-reconnect",
      updatedAt: grant.updatedAt,
      ...(grant.account ? { account: grant.account } : {}),
      ...(grant.expiresAt ? { expiresAt: new Date(grant.expiresAt).toISOString() } : {}),
      ...(!grant.keyMatches
        ? { lastError: "CONNECTIONS_KEY_MISMATCH" }
        : grant.provider !== value.provider.id
          ? { lastError: "CONNECTIONS_PROVIDER_CHANGED" }
          : grant.lastError ? { lastError: grant.lastError } : {}),
    }
  }

  async function inspect(name: string, event?: unknown): Promise<ConnectionSummary> {
    const value = await definition(name)
    return summary(name, value, await store(event).grant(name))
  }

  /** Returns a valid token set. Refreshes under a lease when it expires soon or when `force` is set. */
  async function tokens(name: string, value: ConnectionDefinition, event: unknown, actor: ConnectionActor, force = false): Promise<ConnectionTokenSet> {
    const db = store(event)
    const deadline = Date.now() + leaseWaitMs
    let delay = 50
    let initialRevision: string | undefined
    while (true) {
      const stored = await db.tokens(name)
      if (!stored) throw connectionError("missing", { connection: name })
      if (stored.grant.status === "needs-reconnect") throw connectionError("needs_reconnect", { connection: name })
      // A grant from another provider must never reach the new provider.
      if (stored.grant.provider !== value.provider.id) throw connectionError("needs_reconnect", { connection: name })
      initialRevision ??= stored.grant.revision
      const now = Date.now()
      const refreshedByOther = force && stored.grant.revision !== initialRevision
      const fresh = !force && (stored.tokens.expiresAt === undefined || stored.tokens.expiresAt - refreshSkewMs > now)
      if (fresh || refreshedByOther) return stored.tokens
      if (!stored.tokens.refreshToken) {
        await db.release(name, stored.grant.revision, "needs-reconnect", "CONNECTIONS_NEEDS_RECONNECT")
        throw connectionError("needs_reconnect", { connection: name })
      }
      if (await db.lease(name, stored.grant.revision, now, now + leaseMs)) {
        const started = Date.now()
        try {
          const refreshed = await value.provider.refresh(stored.tokens, providerContext(event))
          await db.write({ expectedRevision: stored.grant.revision, name, provider: value.provider.id, tokens: { ...refreshed, account: refreshed.account ?? stored.tokens.account } })
          await recordQuietly({ action: "refresh", actor, connection: name, durationMs: Date.now() - started, outcome: "succeeded" }, event)
          return refreshed
        }
        catch (error) {
          const reconnect = isConnectionError(error, "needs_reconnect")
          // The revision keeps a stale refresh from marking a newer grant.
          await db.release(name, stored.grant.revision, reconnect ? "needs-reconnect" : "error", errorCode(error)).catch(() => undefined)
          await recordQuietly({ action: "refresh", actor, connection: name, durationMs: Date.now() - started, error: errorCode(error), outcome: "failed", ...(errorStatus(error) ? { status: errorStatus(error) } : {}) }, event)
          throw reconnect ? connectionError("needs_reconnect", { connection: name }, error) : error
        }
      }
      if (Date.now() + delay > deadline) throw connectionError("unavailable", { connection: name })
      await sleep(delay)
      delay = Math.min(delay * 2, 800)
    }
  }

  async function send(name: string, value: ConnectionDefinition, url: URL, init: RequestInit, event: unknown, actor: ConnectionActor): Promise<Response> {
    const authorize = (token: ConnectionTokenSet) => {
      const headers = new Headers(init.headers)
      headers.set("authorization", `${token.tokenType.toLowerCase() === "bearer" ? "Bearer" : token.tokenType} ${token.accessToken}`)
      return fetcher(url, { ...init, headers })
    }
    const token = await tokens(name, value, event, actor)
    const response = await authorize(token)
    // A stream body was read by the first request and cannot be sent again.
    if (response.status !== 401 || !token.refreshToken || init.body instanceof ReadableStream) return response
    // One retry after a forced refresh covers tokens that the provider revoked early.
    await response.body?.cancel().catch(() => undefined)
    return authorize(await tokens(name, value, event, actor, true))
  }

  async function guard(
    name: string,
    value: ConnectionDefinition,
    operation: { effect: ConnectionEffect, id: string },
    options: ConnectionCallOptions,
    url: URL | undefined,
  ): Promise<Omit<ConnectionActivity, "id" | "outcome" | "timestamp">> {
    const base = {
      action: "call" as const,
      actor: options.actor,
      connection: name,
      effect: operation.effect,
      operation: operation.id,
      ...options.trace,
      ...(url ? { target: target(url) } : {}),
    }
    // The credential never leaves the provider origins. Redirects to other origins drop it in `send()`.
    if (url && !matchesConnectionOrigin(value.provider.origins, url)) {
      await recordQuietly({ ...base, error: "CONNECTIONS_ORIGIN_NOT_ALLOWED", outcome: "denied" }, options.event)
      throw connectionError("origin_not_allowed", { connection: name, operation: operation.id })
    }
    const decision = decideConnectionAccess(value.access, options.actor, operation)
    // The decision does not depend on the audit write, so a missing database cannot turn a denial into another error.
    if (decision === "deny") {
      await recordQuietly({ ...base, outcome: "denied" }, options.event)
      throw connectionError("denied", { connection: name, operation: operation.id })
    }
    if (decision === "require-approval" && !options.approved) {
      await recordQuietly({ ...base, outcome: "approval-required" }, options.event)
      throw connectionError("approval_required", { connection: name, operation: operation.id })
    }
    return base
  }

  /** Sends the request and runs `read` on the response. Activity records the outcome after `read`. */
  async function execute<TResult>(
    name: string,
    value: ConnectionDefinition,
    base: Omit<ConnectionActivity, "id" | "outcome" | "timestamp">,
    url: URL,
    init: RequestInit,
    options: ConnectionCallOptions,
    read: (response: Response) => Promise<TResult>,
  ): Promise<TResult> {
    const started = Date.now()
    const audit = options.audit === "all" || base.effect === "write"
    let status: number | undefined
    try {
      const response = await send(name, value, url, init, options.event, options.actor)
      status = response.status
      const result = await read(response)
      if (audit || !response.ok) {
        await recordQuietly({ ...base, durationMs: Date.now() - started, outcome: response.ok ? "succeeded" : "failed", status, ...(response.ok ? {} : { error: "CONNECTIONS_PROVIDER_FAILED" }) }, options.event)
      }
      return result
    }
    catch (error) {
      await recordQuietly({ ...base, durationMs: Date.now() - started, error: errorCode(error), outcome: "failed", ...(status === undefined ? {} : { status }) }, options.event)
      throw error
    }
  }

  return {
    async activity({ before, connection, event, limit }) {
      return store(event).activity({ before, connection, limit })
    },
    async call(name, operation, input, callOptions) {
      const value = await definition(name)
      const request = operation.request(input)
      const url = requestUrl(request)
      const base = await guard(name, value, operation, callOptions, url)
      if (callOptions.dryRun && operation.effect === "write") {
        await recordQuietly({ ...base, outcome: "skipped" }, callOptions.event)
        return { operation: operation.id, skipped: "dry-run" }
      }
      const headers = new Headers(request.headers)
      headers.set("accept", "application/json")
      let body: string | undefined
      if (request.body !== undefined) {
        headers.set("content-type", "application/json")
        body = JSON.stringify(request.body)
      }
      return execute(name, value, base, url, { body, headers, method: request.method }, callOptions, async (response) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw connectionError("provider_failed", { connection: name, operation: operation.id, status: response.status })
        }
        const text = await response.text()
        let parsed: unknown
        try {
          parsed = text ? JSON.parse(text) : undefined
        }
        catch (error) {
          throw connectionError("provider_failed", { connection: name, operation: operation.id, status: response.status }, error)
        }
        // SAFETY: Without a parse function, the Operation declaration states the provider response shape.
        return operation.parse ? operation.parse(parsed) : parsed as never
      })
    },
    async decide(name, actor, operation) {
      return decideConnectionAccess((await definition(name)).access, actor, operation)
    },
    async disconnect(name, lifecycle) {
      const db = store(lifecycle.event)
      // One read gives the grant and its tokens. A connect that finishes later writes a newer revision, which stays.
      const snapshot = await db.snapshot(name)
      const value = await definition(name)
      let revokeError: string | undefined
      // Only the provider that issued the grant may receive it for revocation.
      if (snapshot?.tokens && snapshot.grant.provider === value.provider.id && value.provider.revoke) {
        await value.provider.revoke(snapshot.tokens, providerContext(lifecycle.event)).catch((error: unknown) => {
          revokeError = errorCode(error)
        })
      }
      if (snapshot) await db.deleteGrant(name, snapshot.grant.revision)
      // The grant is gone now. An audit failure must not report the disconnect as failed.
      await recordQuietly({ action: "disconnect", actor: lifecycle.actor, connection: name, outcome: "succeeded", ...(revokeError ? { error: revokeError } : {}) }, lifecycle.event)
      // A connect that finished during revocation keeps its newer grant, so report the Connection as it is now.
      return summary(name, value, await db.grant(name))
    },
    async fetch(name, input, init = {}, callOptions) {
      const value = await definition(name)
      const url = new URL(input)
      const method = (init.method ?? "GET").toUpperCase()
      const effect: ConnectionEffect = method === "GET" || method === "HEAD" ? "read" : "write"
      const base = await guard(name, value, { effect, id: `fetch.${method.toLowerCase()}` }, callOptions, url)
      if (callOptions.dryRun && effect === "write") {
        await recordQuietly({ ...base, outcome: "skipped" }, callOptions.event)
        return new Response(null, { headers: { "x-vitehub-connection-skipped": "dry-run" }, status: 204 })
      }
      return execute(name, value, base, url, { ...init, method }, callOptions, async response => response)
    },
    inspect,
    async list(event) {
      return Promise.all(names().map(name => inspect(name, event)))
    },
    names,
    async open({ event, name, ticket }) {
      const value = await definition(name)
      const pending = await store(event).openPending(ticket, Date.now())
      if (!pending || pending.name !== name) throw connectionError("invalid", { connection: name })
      const authorizationUrl = await value.provider.authorizationUrl({
        codeChallenge: await codeChallenge(pending.verifier),
        redirectUri: pending.redirectUri,
        state: pending.state,
      }, providerContext(event))
      return { authorizationUrl, state: pending.state }
    },
    record,
    async callback(input) {
      const value = await definition(input.name)
      const db = store(input.event)
      if (!input.state || !input.cookieState || input.state !== input.cookieState) {
        throw connectionError("invalid", { connection: input.name })
      }
      const pending = await db.consumePending(input.state, Date.now())
      if (!pending || pending.name !== input.name) throw connectionError("invalid", { connection: input.name })
      const started = Date.now()
      try {
        if (input.error || !input.code) throw connectionError("provider_failed", { connection: input.name })
        const tokenSet = await value.provider.exchange({ code: input.code, codeVerifier: pending.verifier, redirectUri: pending.redirectUri }, providerContext(input.event))
        const grant = await db.write({ name: input.name, provider: value.provider.id, tokens: tokenSet })
        // The grant is active now. An audit failure must not report the connect as failed.
        await recordQuietly({ action: "connect", actor: pending.actor, connection: input.name, durationMs: Date.now() - started, outcome: "succeeded" }, input.event)
        return summary(input.name, value, grant)
      }
      catch (error) {
        await recordQuietly({ action: "connect", actor: pending.actor, connection: input.name, durationMs: Date.now() - started, error: errorCode(error), outcome: "failed" }, input.event)
        throw error
      }
    },
    async refresh(name, lifecycle) {
      const value = await definition(name)
      await tokens(name, value, lifecycle.event, lifecycle.actor, true)
      return inspect(name, lifecycle.event)
    },
    async start(name, lifecycle) {
      await definition(name)
      const origin = new URL(lifecycle.origin).origin
      const ticket = randomToken()
      const expiresAt = Date.now() + pendingTtlMs
      await store(lifecycle.event).createPending({
        actor: lifecycle.actor,
        expiresAt,
        name,
        redirectUri: `${origin}${basePath}/${encodeURIComponent(name)}/callback`,
        state: randomToken(),
        ticket,
        verifier: randomToken(),
      })
      return {
        expiresAt: new Date(expiresAt).toISOString(),
        url: `${origin}${basePath}/${encodeURIComponent(name)}/connect?ticket=${ticket}`,
      }
    },
  }
}
