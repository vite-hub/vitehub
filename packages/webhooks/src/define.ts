import { parseDuration } from "@vite-hub/runtime"

import { webhooksErrors } from "./errors.ts"

import type { Duration } from "@vite-hub/runtime"

/** How a delivery is signed. Both use HMAC-SHA256 of the raw body with the secret. */
export type WebhookSignature = "github" | "stripe"

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
   * Wait this long after the last send before one delivery, such as `"30m"`. Each send in the window replaces the body
   * and restarts the wait. Sends with the same `key` collapse, and the key defaults to the webhook name. At most `"1d"`.
   * Without it, each send is delivered at once.
   */
  debounce?: Duration
}

/** A webhook of `server/webhooks/<name>.ts`. */
export interface WebhookDefinition {
  readonly url: string
  readonly secret: string
  readonly signature: WebhookSignature
  /** The debounce in milliseconds. `0` delivers each send at once. */
  readonly debounceMs: number
}

const definitionBrand = Symbol.for("vitehub.webhooks.definition")

/** 24 hours: the longest delay of Cloudflare Queues, the shortest of every host. */
export const maxDebounceMs = 24 * 60 * 60 * 1000

const variableName = /^[A-Z_][A-Z0-9_]*$/i

function invalid(message: string): Error {
  return webhooksErrors.WEBHOOKS_DEFINITION_INVALID({ message: `[vitehub] ${message}` })
}

/**
 * Defines a webhook: where ViteHub sends events, how it signs them, and how long it waits to collapse them. Default-export
 * it from `server/webhooks/<name>.ts`, then call `sendWebhook("<name>", body)` from server code.
 *
 * ```ts [server/webhooks/t3.ts]
 * import { defineWebhook } from "@vite-hub/webhooks"
 *
 * export default defineWebhook({
 *   url: "T3_WEBHOOK_URL",
 *   secret: "T3_WEBHOOK_SECRET",
 *   debounce: "30m",
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
  const debounceMs = options.debounce === undefined ? 0 : parseDuration(options.debounce, "debounce")
  if (debounceMs > maxDebounceMs) throw webhooksErrors.WEBHOOKS_DEBOUNCE_TOO_LONG({ debounce: JSON.stringify(options.debounce) })
  return Object.defineProperty({ url: options.url, secret: options.secret, signature, debounceMs }, definitionBrand, { value: true })
}

export function isWebhookDefinition(value: unknown): value is WebhookDefinition {
  return typeof value === "object" && value !== null && Reflect.get(value, definitionBrand) === true
}
