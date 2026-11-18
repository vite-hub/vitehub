import { runFailedEventNames } from "@vite-hub/runtime/internal/run-failed"

import { webhooksErrors } from "./errors.ts"

import type { RunFailedEventName } from "@vite-hub/runtime/internal/run-failed"

/** How a delivery is signed. Both use HMAC-SHA256 of the raw body with the secret. */
export type WebhookSignature = "github" | "stripe"

/**
 * An event that ViteHub sends by itself, with no `sendWebhook()` call: an Agent Invocation, a Workflow run, or a Schedule
 * run that ended in failure with no retry left.
 */
export type WebhookEvent = RunFailedEventName

/** What `defineWebhook()` accepts. */
export interface WebhookOptions {
  /**
   * The name of the server variable that holds the receiver URL, such as `"T3_WEBHOOK_URL"`. It is a name, not the URL,
   * because a URL often holds a token.
   */
  url: string
  /** The name of the server variable that holds the signing secret, such as `"T3_WEBHOOK_SECRET"`. */
  secret: string
  /**
   * `"github"` (default) sends `x-hub-signature-256: sha256=<hex>`. `"stripe"` sends
   * `stripe-signature: t=<time>,v1=<hex>`. `verifyWebhook()` from `@vite-hub/env` checks both.
   */
  signature?: WebhookSignature
  /**
   * Wait this long after the last send before one delivery, such as `"30 minutes"`. Each send in the window replaces the
   * body and restarts the wait. Sends with the same `key` collapse, and the key defaults to the webhook name. At most 24
   * hours. Without it, each send is delivered at once.
   */
  debounce?: string | number
  /**
   * Events that ViteHub sends to this webhook by itself: `"invocation.failed"`, `"workflow.failed"`, and
   * `"schedule.failed"`. Each is sent once, when the run ends in failure with no retry left.
   */
  events?: readonly WebhookEvent[]
}

/** A webhook of `server/webhooks/<name>.ts`. */
export interface WebhookDefinition {
  readonly url: string
  readonly secret: string
  readonly signature: WebhookSignature
  /** The debounce in milliseconds. `0` delivers each send at once. */
  readonly debounceMs: number
  /** The events that ViteHub sends to this webhook by itself. */
  readonly events: readonly WebhookEvent[]
}

const definitionBrand = Symbol.for("vitehub.webhooks.definition")

/** 24 hours: the longest delay of Cloudflare Queues, the shortest of every host. */
export const maxDebounceMs = 24 * 60 * 60 * 1000

const durationUnits: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
}

/** Milliseconds of a duration such as `"30 minutes"`, `"10s"`, or a number of milliseconds. */
function parseDuration(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(value.trim())
  const unit = match && durationUnits[match[2]!.toLowerCase()]
  return unit ? Number(match[1]) * unit : undefined
}

const variableName = /^[A-Z_][A-Z0-9_]*$/i

function isWebhookEvent(value: unknown): value is WebhookEvent {
  return runFailedEventNames.some(name => name === value)
}

function invalid(message: string): Error {
  return webhooksErrors.WEBHOOKS_DEFINITION_INVALID({ message: `[vitehub] ${message}` })
}

/**
 * Defines a webhook: where ViteHub sends events, how it signs them, and how long it waits to collapse them. Default-export
 * it from `server/webhooks/<name>.ts`, then call `sendWebhook("<name>", body)` from server code, or list `events` that
 * ViteHub sends by itself.
 *
 * ```ts [server/webhooks/t3.ts]
 * import { defineWebhook } from "@vite-hub/webhooks"
 *
 * export default defineWebhook({
 *   url: "T3_WEBHOOK_URL",
 *   secret: "T3_WEBHOOK_SECRET",
 *   debounce: "30 minutes",
 * })
 * ```
 */
export function defineWebhook(options: WebhookOptions): WebhookDefinition {
  for (const key of ["url", "secret"] as const) {
    const value: unknown = options?.[key]
    if (typeof value !== "string" || !variableName.test(value)) {
      throw invalid(`\`${key}\` must be the name of a server variable, such as ${key === "url" ? "\"T3_WEBHOOK_URL\"" : "\"T3_WEBHOOK_SECRET\""}, not ${JSON.stringify(value)}.`)
    }
  }
  const signature = options.signature ?? "github"
  if (signature !== "github" && signature !== "stripe") throw invalid(`\`signature\` must be "github" or "stripe", not ${JSON.stringify(signature)}.`)
  const debounceMs = options.debounce === undefined ? 0 : parseDuration(options.debounce)
  if (debounceMs === undefined) throw invalid(`\`debounce\` must be a duration such as "30 minutes" or "10s", not ${JSON.stringify(options.debounce)}.`)
  if (debounceMs > maxDebounceMs) throw webhooksErrors.WEBHOOKS_DEBOUNCE_TOO_LONG({ debounce: JSON.stringify(options.debounce) })
  const listed: unknown = options.events ?? []
  if (!Array.isArray(listed)) throw invalid(`\`events\` must be a list such as ["workflow.failed"], not ${JSON.stringify(listed)}.`)
  const items: readonly unknown[] = listed
  const events = new Set<WebhookEvent>()
  for (const event of items) {
    if (!isWebhookEvent(event)) throw invalid(`\`events\` lists ${JSON.stringify(event)}. Use ${runFailedEventNames.map(name => JSON.stringify(name)).join(", ")}.`)
    events.add(event)
  }
  return Object.defineProperty({ url: options.url, secret: options.secret, signature, debounceMs, events: [...events] }, definitionBrand, { value: true })
}

export function isWebhookDefinition(value: unknown): value is WebhookDefinition {
  return typeof value === "object" && value !== null && Reflect.get(value, definitionBrand) === true
}
