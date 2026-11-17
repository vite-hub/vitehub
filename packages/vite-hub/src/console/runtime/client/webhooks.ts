import { requestConsoleOperation } from "./request"

import type { ConsoleOperationTone } from "../definitions"

// These types mirror `WebhookInfo` and `WebhookDelivery` of `@vite-hub/webhooks`. Console runtime files ship as source
// and cannot import an optional owner package.

/** One webhook, as `webhooks.list` answers. It names the variables, never their values. */
export interface ConsoleWebhook {
  name: string
  /** The name of the variable with the URL. */
  url: string
  /** The name of the variable with the secret. */
  secret: string
  signature: "github" | "stripe"
  debounceMs: number
  urlSet: boolean
  secretSet: boolean
  /** The host of the URL. Never the path or the query. */
  host: string | null
}

export type ConsoleWebhookDeliveryState = "pending" | "sending" | "sent" | "dead" | "cancelled"

/** One delivery, as `webhooks.deliveries`, `webhooks.pending`, and `webhooks.get` answer. Times are epoch milliseconds. */
export interface ConsoleWebhookDelivery {
  id: string
  webhook: string
  key: string | null
  event: string
  body: unknown
  count: number
  state: ConsoleWebhookDeliveryState
  attempts: number
  lastStatus: number | null
  lastError: string | null
  dueAt: number
  createdAt: number
  updatedAt: number
  sentAt: number | null
}

/** The filters of the delivery log. `all` is the default and is left out of the URL. */
export const webhookLogFilters = ["all", "sent", "dead", "cancelled"] as const

export type ConsoleWebhookLogFilter = (typeof webhookLogFilters)[number]

/** The operations of `@vite-hub/webhooks` that the section calls. */
export const webhooksOperations = {
  list: "webhooks.list",
  deliveries: "webhooks.deliveries",
  pending: "webhooks.pending",
  get: "webhooks.get",
  test: "webhooks.test",
  flush: "webhooks.flush",
  cancel: "webhooks.cancel",
  redeliver: "webhooks.redeliver",
} as const

function list<T>(value: unknown): T[] {
  // SAFETY: The `webhooks.*` read operations answer with arrays of the shapes above.
  return Array.isArray(value) ? value as T[] : []
}

export async function readWebhooks(signal?: AbortSignal): Promise<ConsoleWebhook[]> {
  return list<ConsoleWebhook>(await requestConsoleOperation(webhooksOperations.list, {}, signal ? { signal } : {}))
}

export async function readPendingWebhookDeliveries(signal?: AbortSignal): Promise<ConsoleWebhookDelivery[]> {
  return list<ConsoleWebhookDelivery>(await requestConsoleOperation(webhooksOperations.pending, {}, signal ? { signal } : {}))
}

/** The newest 100 deliveries, of one state when the filter names one. */
export async function readWebhookDeliveries(filter: ConsoleWebhookLogFilter, signal?: AbortSignal): Promise<ConsoleWebhookDelivery[]> {
  const input = filter === "all" ? {} : { state: filter }
  return list<ConsoleWebhookDelivery>(await requestConsoleOperation(webhooksOperations.deliveries, input, signal ? { signal } : {}))
}

export async function readWebhookDelivery(id: string, signal?: AbortSignal): Promise<ConsoleWebhookDelivery> {
  // SAFETY: `webhooks.get` answers with one delivery.
  return await requestConsoleOperation(webhooksOperations.get, { id }, signal ? { signal } : {}) as ConsoleWebhookDelivery
}

/** Sends a test delivery now. The answer names the new delivery. */
export async function testWebhook(name: string): Promise<{ id: string }> {
  // SAFETY: `webhooks.test` answers with `{ id, status }`.
  return await requestConsoleOperation(webhooksOperations.test, { name }) as { id: string }
}

/** Runs Send now, Cancel, or Redeliver on one delivery. */
export async function changeWebhookDelivery(action: "flush" | "cancel" | "redeliver", id: string): Promise<void> {
  await requestConsoleOperation(webhooksOperations[action], { id })
}

/** A debounce in words, such as `30 min debounce`, or `No debounce` for a webhook that delivers each send at once. */
export function webhookDebounceLabel(ms: number): string {
  if (!(ms > 0)) return "No debounce"
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds} s debounce`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min debounce`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} h${rest ? ` ${rest} min` : ""} debounce`
}

/** How long until a pending delivery fires, such as `fires in 21 min`, `fires in 42 s`, or `due now` once it is due. */
export function webhookCountdown(dueAt: number, now: number): string {
  const left = Math.ceil((dueAt - now) / 1_000)
  if (left <= 0) return "due now"
  if (left < 60) return `fires in ${left} s`
  const minutes = Math.ceil(left / 60)
  if (minutes < 60) return `fires in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `fires in ${hours} h${rest ? ` ${rest} min` : ""}`
}

/** `1 event`, `4 events`: the sends that one debounced delivery collapses. */
export function webhookEventCount(count: number): string {
  return `${count} ${count === 1 ? "event" : "events"}`
}

const stateTones: Readonly<Record<ConsoleWebhookDeliveryState, ConsoleOperationTone>> = {
  cancelled: "neutral",
  dead: "error",
  pending: "info",
  sending: "warning",
  sent: "success",
}

/** The status badge of a delivery state, such as `Dead` in red. */
export function webhookStateStatus(state: ConsoleWebhookDeliveryState): { label: string, tone: ConsoleOperationTone } {
  return { label: `${state.charAt(0).toUpperCase()}${state.slice(1)}`, tone: Object.hasOwn(stateTones, state) ? stateTones[state] : "neutral" }
}

/** The answer of the last attempt, such as `HTTP 500`, the error without a status, or `No attempt` before the first. */
export function webhookLastResult(delivery: Pick<ConsoleWebhookDelivery, "attempts" | "lastError" | "lastStatus">): string {
  if (delivery.lastStatus !== null) return `HTTP ${delivery.lastStatus}`
  if (delivery.lastError) return delivery.lastError
  return delivery.attempts ? "No answer" : "No attempt"
}

/** `1 attempt`, `4 attempts`. */
export function webhookAttempts(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`
}

/** Redeliver sends a sent, dead, or cancelled delivery again. A pending or sending delivery cannot be redelivered. */
export function canRedeliverWebhook(state: ConsoleWebhookDeliveryState): boolean {
  return state === "sent" || state === "dead" || state === "cancelled"
}

/** The variables of a webhook that have no value on this server, in the order URL, secret. */
export function missingWebhookVariables(webhook: ConsoleWebhook): string[] {
  return [...(webhook.urlSet ? [] : [webhook.url]), ...(webhook.secretSet ? [] : [webhook.secret])]
}
