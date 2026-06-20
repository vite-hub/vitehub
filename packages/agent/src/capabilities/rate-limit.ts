import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentInvoker,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"

export type RateLimitWindow =
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`

export type RateLimitIdentity =
  | "auto"
  | "invoker"
  | "ip"
  | "run"
  | RateLimitIdentityResolver

export type RateLimitIdentityResolver = (
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<string | null | undefined>

export type RateLimitAction = "check" | "consume"

export type RateLimitLimitResolver = (
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<number>

export type RateLimitLimit = number | RateLimitLimitResolver

export interface RateLimitStoreInput {
  action: RateLimitAction
  capabilityId: string
  context: AgentCapabilityRuntimeContext
  identity: string
  identitySource: string
  invoker: AgentInvoker
  key: string
  limit: number
  now: number
  scope: string
  windowMs: number
}

export interface RateLimitStoreResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  used: number
}

export interface RateLimitStore {
  check: (input: RateLimitStoreInput) => MaybePromise<RateLimitStoreResult>
  consume: (input: RateLimitStoreInput) => MaybePromise<RateLimitStoreResult>
}

export interface MemoryRateLimitStore extends RateLimitStore {
  clear: () => void
  size: () => number
}

export interface MemoryRateLimitStoreOptions {
  maxEntries?: number
}

export interface RateLimitDecision {
  action: RateLimitAction
  allowed: boolean
  capabilityId: string
  identity: string
  identitySource: string
  key: string
  limit: number
  remaining: number
  resetAt: number
  retryAfter: number
  scope: string
  used: number
  windowMs: number
}

export interface RateLimitEvent {
  context: AgentCapabilityRuntimeContext
  decision: RateLimitDecision
  input: RateLimitStoreInput
  store: RateLimitStore
}

export interface RateLimitOptions {
  action?: RateLimitAction
  id?: string
  identity?: RateLimitIdentity
  limit: RateLimitLimit
  message?: string | ((decision: RateLimitDecision) => string)
  onAllowed?: (event: RateLimitEvent) => MaybePromise<void>
  onDecision?: (event: RateLimitEvent) => MaybePromise<void>
  onRejected?: (event: RateLimitEvent) => MaybePromise<void>
  scope?: string | ((context: AgentCapabilityRuntimeContext) => MaybePromise<string>)
  store?: RateLimitStore | "memory" | ((context: AgentCapabilityRuntimeContext) => MaybePromise<RateLimitStore | "memory">)
  trustedIpHeaders?: string[]
  window: RateLimitWindow
}

interface MemoryEntry {
  count: number
  resetAt: number
}

const DEFAULT_MEMORY_MAX_ENTRIES = 100_000

export class RateLimitRejectedError extends Error {
  capabilityId: string
  decision: RateLimitDecision
  headers: Record<string, string>
  retryAfter: number

  constructor(capabilityId: string, decision: RateLimitDecision, message?: string) {
    super(message || "Rate limit exceeded. Try again later.")
    this.capabilityId = capabilityId
    this.decision = decision
    this.headers = {
      "retry-after": String(decision.retryAfter),
      "x-retry-after": String(decision.retryAfter),
    }
    this.name = "RateLimitRejectedError"
    this.retryAfter = decision.retryAfter
    Object.defineProperty(this, "statusCode", {
      enumerable: true,
      value: 429,
    })
  }
}

export function memoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): MemoryRateLimitStore {
  const entries = new Map<string, MemoryEntry>()
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES))

  function prune(now: number) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key)
    }
    if (entries.size <= maxEntries) return
    const overflow = entries.size - maxEntries
    let removed = 0
    for (const key of entries.keys()) {
      entries.delete(key)
      removed += 1
      if (removed >= overflow) return
    }
  }

  function readEntry(input: RateLimitStoreInput): MemoryEntry {
    prune(input.now)
    const windowStart = Math.floor(input.now / input.windowMs) * input.windowMs
    const resetAt = windowStart + input.windowMs
    const current = entries.get(input.key)
    return current && current.resetAt > input.now
      ? current
      : { count: 0, resetAt }
  }

  return {
    async check(input) {
      const active = readEntry(input)
      return {
        allowed: active.count < input.limit,
        limit: input.limit,
        remaining: Math.max(0, input.limit - active.count),
        resetAt: active.resetAt,
        used: active.count,
      }
    },
    clear() {
      entries.clear()
    },
    async consume(input) {
      const active = readEntry(input)
      const nextCount = active.count + 1
      if (nextCount > input.limit) {
        return {
          allowed: false,
          limit: input.limit,
          remaining: 0,
          resetAt: active.resetAt,
          used: active.count,
        }
      }
      entries.set(input.key, { count: nextCount, resetAt: active.resetAt })
      return {
        allowed: true,
        limit: input.limit,
        remaining: Math.max(0, input.limit - nextCount),
        resetAt: active.resetAt,
        used: nextCount,
      }
    },
    size() {
      return entries.size
    },
  }
}

function parseRateLimitWindow(value: RateLimitWindow): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  if (!match) {
    throw new TypeError(`[vitehub] rateLimit({ window }) must use a unit such as "500ms", "60s", "15m", "1h", or "1d".`)
  }
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TypeError("[vitehub] rateLimit({ window }) must be greater than zero.")
  }
  const unit = match[2]
  const multiplier = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000
  return Math.ceil(amount * multiplier)
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("[vitehub] rateLimit({ limit }) must be a positive integer.")
  }
  return value
}

async function resolveLimit(
  value: RateLimitLimit,
  context: AgentCapabilityRuntimeContext,
): Promise<number> {
  return normalizeLimit(typeof value === "function" ? await value(context) : value)
}

function normalizeAction(value: RateLimitAction | undefined): RateLimitAction {
  if (value === undefined) return "consume"
  if (value === "check" || value === "consume") return value
  throw new TypeError("[vitehub] rateLimit({ action }) must be \"check\" or \"consume\".")
}

function resolveRunIdentity(context: AgentCapabilityRuntimeContext): string | undefined {
  const run = context.run
  if (!run) return
  return [
    run.threadId && run.origin ? `${run.origin}:thread:${run.threadId}` : undefined,
    run.threadId ? `thread:${run.threadId}` : undefined,
    run.channelId && run.origin ? `${run.origin}:channel:${run.channelId}` : undefined,
    run.channelId ? `channel:${run.channelId}` : undefined,
  ].find((value): value is string => typeof value === "string" && value.length > 0)
}

function forwardedFor(value: string): string | undefined {
  const first = value.split(",")[0]?.trim()
  return first || undefined
}

function forwardedHeader(value: string): string | undefined {
  const first = value.split(",")[0]?.trim()
  const match = /(?:^|;)\s*for=(?:"?\[?)([^;,"\]]+)/i.exec(first || "")
  return match?.[1]
}

function resolveIpIdentity(context: AgentCapabilityRuntimeContext, trustedIpHeaders: string[] | undefined): string | undefined {
  const headers = context.request?.headers
  if (!headers || !trustedIpHeaders?.length) return
  for (const name of trustedIpHeaders) {
    const value = headers.get(name)
    if (!value) continue
    if (name.toLowerCase() === "x-forwarded-for") return forwardedFor(value)
    if (name.toLowerCase() === "forwarded") return forwardedHeader(value)
    return value.trim() || undefined
  }
}

function invokerIdentity(invoker: AgentInvoker): string {
  return `${invoker.kind || "invoker"}:${invoker.id}`
}

async function resolveIdentity(
  identity: RateLimitIdentity,
  context: AgentCapabilityRuntimeContext,
  trustedIpHeaders: string[] | undefined,
): Promise<{ source: string, value: string }> {
  if (typeof identity === "function") {
    const value = await identity(context)
    if (value) return { source: "custom", value }
    throw new Error("[vitehub] rateLimit({ identity }) returned no identity.")
  }
  if (identity === "invoker") {
    return { source: "invoker", value: invokerIdentity(context.invoker) }
  }
  if (identity === "run") {
    const value = resolveRunIdentity(context)
    if (value) return { source: "run", value }
    throw new Error("[vitehub] rateLimit({ identity: \"run\" }) could not resolve Agent Run metadata.")
  }
  if (identity === "ip") {
    const value = resolveIpIdentity(context, trustedIpHeaders)
    if (value) return { source: "ip", value }
    throw new Error("[vitehub] rateLimit({ identity: \"ip\" }) requires trustedIpHeaders and a matching request header.")
  }
  return resolveAutoIdentity(context, trustedIpHeaders)
}

function resolveAutoIdentity(context: AgentCapabilityRuntimeContext, trustedIpHeaders: string[] | undefined): { source: string, value: string } {
  if (context.invoker.id) return { source: "invoker", value: invokerIdentity(context.invoker) }
  const run = resolveRunIdentity(context)
  if (run) return { source: "run", value: run }
  const ip = resolveIpIdentity(context, trustedIpHeaders)
  if (ip) return { source: "ip", value: ip }
  return { source: "anonymous", value: "anonymous" }
}

function fallbackHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

async function hashKeyPart(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  }
  return fallbackHash(value)
}

function stableKeyPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "default"
}

async function resolveScope(
  scope: RateLimitOptions["scope"],
  context: AgentCapabilityRuntimeContext,
  id: string,
): Promise<string> {
  if (typeof scope === "function") return stableKeyPart(await scope(context))
  if (typeof scope === "string") return stableKeyPart(scope)
  return stableKeyPart(id)
}

async function resolveStore(
  store: RateLimitOptions["store"],
  context: AgentCapabilityRuntimeContext,
  fallback: RateLimitStore,
): Promise<RateLimitStore> {
  if (!store) {
    if (isHostedRuntime(context.runtime)) {
      throw new Error(`[vitehub] rateLimit() requires an explicit store on hosted runtime "${context.runtime}". Use store: "memory" only for local development, tests, or single-process hosts.`)
    }
    return fallback
  }
  const resolved = typeof store === "function" ? await store(context) : store
  if (resolved === "memory") return fallback
  if (!resolved || typeof resolved.check !== "function" || typeof resolved.consume !== "function") {
    throw new TypeError("[vitehub] rateLimit({ store }) must provide check() and consume() functions.")
  }
  return resolved
}

function isHostedRuntime(runtime: string): boolean {
  return runtime === "vercel" || runtime === "cloudflare-agents" || runtime === "deno"
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000))
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`[vitehub] ${label} must be a non-negative integer.`)
  }
  return value
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`[vitehub] ${label} must be a positive timestamp.`)
  }
  return value
}

function normalizeStoreResult(result: RateLimitStoreResult): RateLimitStoreResult {
  if (!result || typeof result !== "object") {
    throw new TypeError("[vitehub] rateLimit store methods must return a result object.")
  }
  if (typeof result.allowed !== "boolean") {
    throw new TypeError("[vitehub] rateLimit store result allowed must be a boolean.")
  }
  return {
    allowed: result.allowed,
    limit: normalizeLimit(result.limit),
    remaining: normalizeNonNegativeInteger(result.remaining, "rateLimit store result remaining"),
    resetAt: normalizeTimestamp(result.resetAt, "rateLimit store result resetAt"),
    used: normalizeNonNegativeInteger(result.used, "rateLimit store result used"),
  }
}

function resolveRejectedMessage(
  option: RateLimitOptions["message"],
  decision: RateLimitDecision,
): string | undefined {
  return typeof option === "function" ? option(decision) : option
}

async function notifyRateLimitDecision(
  options: RateLimitOptions,
  event: RateLimitEvent,
): Promise<void> {
  await options.onDecision?.(event)
  if (event.decision.allowed) {
    await options.onAllowed?.(event)
  }
  else {
    await options.onRejected?.(event)
  }
}

export function rateLimit(
  options: RateLimitOptions,
): AgentCapabilityDefinition<AgentRuntimeConfig> {
  const id = options.id || "rate-limit"
  const staticLimit = typeof options.limit === "number"
    ? normalizeLimit(options.limit)
    : undefined
  const windowMs = parseRateLimitWindow(options.window)
  const action = normalizeAction(options.action)
  const fallbackStore = memoryRateLimitStore()
  const identity = options.identity || "auto"
  const trustedIpHeaders = options.trustedIpHeaders?.map(header => header.trim()).filter(Boolean)

  return defineCapability({
    id,
    metadata: {
      kind: "rate-limit",
    },
    configure(context) {
      context.finish.provide(() => context.context.get(id))
    },
    async input(context) {
      if (context.context.has(id)) {
        throw new Error(`[vitehub] Invocation context value "${id}" is already set.`)
      }
      const now = Date.now()
      const limit = staticLimit ?? await resolveLimit(options.limit, context)
      const resolvedIdentity = await resolveIdentity(identity, context, trustedIpHeaders)
      const scope = await resolveScope(options.scope, context, id)
      const key = `vitehub:rate-limit:${stableKeyPart(id)}:${scope}:${await hashKeyPart(`${resolvedIdentity.source}:${resolvedIdentity.value}`)}`
      const store = await resolveStore(options.store, context, fallbackStore)
      const storeInput: RateLimitStoreInput = {
        action,
        capabilityId: id,
        context,
        identity: resolvedIdentity.value,
        identitySource: resolvedIdentity.source,
        invoker: context.invoker,
        key,
        limit,
        now,
        scope,
        windowMs,
      }
      const consumed = normalizeStoreResult(await store[action](storeInput))
      const decision: RateLimitDecision = {
        action,
        allowed: consumed.allowed,
        capabilityId: id,
        identity: resolvedIdentity.value,
        identitySource: resolvedIdentity.source,
        key,
        limit: consumed.limit,
        remaining: Math.max(0, consumed.remaining),
        resetAt: consumed.resetAt,
        retryAfter: consumed.allowed ? 0 : retryAfterSeconds(consumed.resetAt, now),
        scope,
        used: consumed.used,
        windowMs,
      }
      context.context.set(id, decision)
      await notifyRateLimitDecision(options, {
        context,
        decision,
        input: storeInput,
        store,
      })
      if (!decision.allowed) {
        throw new RateLimitRejectedError(id, decision, resolveRejectedMessage(options.message, decision))
      }
    },
  })
}
