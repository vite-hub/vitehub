import { defineCapability } from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"

import type {
  RateLimitDecision as CoreRateLimitDecision,
  RateLimiter,
} from "@vite-hub/rate-limit"
import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentInvoker,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"

export type RateLimitIdentity =
  | "auto"
  | "invoker"
  | "ip"
  | "run"
  | RateLimitIdentityResolver

export type RateLimitIdentityResolver = (
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<string | null | undefined>

export type RateLimitLimiter =
  | RateLimiter
  | RateLimitLimiterResolver

export type RateLimitLimiterResolver = (
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<RateLimiter>

interface RateLimitDecisionContext {
  capabilityId: string
  identity: string
  identitySource: string
  key: string
  scope: string
}

type WithRateLimitDecisionContext<TDecision> = TDecision extends CoreRateLimitDecision
  ? TDecision & RateLimitDecisionContext
  : never

export type RateLimitDecision = WithRateLimitDecisionContext<CoreRateLimitDecision>

export interface RateLimitEvent {
  context: AgentCapabilityRuntimeContext
  decision: RateLimitDecision
  limiter: RateLimiter
}

export interface RateLimitOptions {
  id?: string
  identity?: RateLimitIdentity
  limiter: RateLimitLimiter
  message?: string | ((decision: RateLimitDecision) => string)
  onAllowed?: (event: RateLimitEvent) => MaybePromise<void>
  onDecision?: (event: RateLimitEvent) => MaybePromise<void>
  onRejected?: (event: RateLimitEvent) => MaybePromise<void>
  scope?: string | ((context: AgentCapabilityRuntimeContext) => MaybePromise<string>)
  trustedIpHeaders?: string[]
}

function rateLimitRejectedError(capabilityId: string, decision: RateLimitDecision, message?: string) {
  const unavailable = decision.reason === "unavailable"
  return new ViteHubError(unavailable ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMIT_REJECTED", message || (unavailable ? "Rate limiting is unavailable." : "Rate limit exceeded. Try again later."), {
    cause: unavailable ? decision.cause : undefined,
    details: {
      capabilityId,
      reason: decision.reason,
      retryAfter: decision.retryAfter,
    },
  })
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

async function resolveLimiter(
  limiter: RateLimitLimiter,
  context: AgentCapabilityRuntimeContext,
): Promise<RateLimiter> {
  const resolved = typeof limiter === "function" ? await limiter(context) : limiter
  if (!resolved || typeof resolved.consume !== "function") {
    throw new TypeError("[vitehub] rateLimit({ limiter }) must be a RateLimiter.")
  }
  return resolved
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
      const resolvedIdentity = await resolveIdentity(identity, context, trustedIpHeaders)
      const scope = await resolveScope(options.scope, context, id)
      const key = `vitehub:rate-limit:${stableKeyPart(id)}:${scope}:${await hashKeyPart(`${resolvedIdentity.source}:${resolvedIdentity.value}`)}`
      const limiter = await resolveLimiter(options.limiter, context)
      const consumed = await limiter.consume({ key })
      const decision: RateLimitDecision = {
        ...consumed,
        capabilityId: id,
        identity: resolvedIdentity.value,
        identitySource: resolvedIdentity.source,
        key,
        scope,
      }
      context.context.set(id, decision)
      await notifyRateLimitDecision(options, {
        context,
        decision,
        limiter,
      })
      if (!decision.allowed) {
        throw rateLimitRejectedError(id, decision, resolveRejectedMessage(options.message, decision))
      }
    },
  })
}
