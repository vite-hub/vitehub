import { ConsoleRequestError, requestConsoleOperation } from "./request"

import type { ConsoleOperationTone } from "../definitions"

// These types mirror `WebhookInfo`, `WebhookDelivery`, and `MemberEndpointRow` of `@vite-hub/webhooks`. Console runtime
// files ship as source and cannot import an optional owner package.

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

/**
 * One member endpoint, as `webhooks.endpoints` answers: where a member's Send goes. It never holds the URL, the secret,
 * or the owner's email. `mine` is true when the Console user owns it.
 */
export interface ConsoleMemberEndpoint {
  id: string
  owner: string
  ownerName: string | null
  name: string
  /** Where the agent can be reached, such as the T3 thread it paired from. */
  address: string | null
  kind: "url" | "inbox"
  agent: string | null
  host: string | null
  disabledAt: number | null
  disabledBy: string | null
  createdAt: number
  updatedAt: number
  mine: boolean
  /** The newest delivery to it. `failures` counts the dead ones in a row. */
  last: { state: ConsoleWebhookDeliveryState, status: number | null, error: string | null, at: number, failures: number } | null
}

/** A member delivery names its endpoint as `@<endpoint id>` in `webhook`. */
export const memberWebhookPrefix = "@"

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
  endpoints: "webhooks.endpoints",
  disableEndpoint: "webhooks.disable-endpoint",
  enableEndpoint: "webhooks.enable-endpoint",
} as const

function webhookList(value: unknown): ConsoleWebhook[] {
  // SAFETY: `webhooks.list` answers with an array of webhooks.
  return Array.isArray(value) ? value as ConsoleWebhook[] : []
}

function deliveryList(value: unknown): ConsoleWebhookDelivery[] {
  // SAFETY: `webhooks.deliveries` and `webhooks.pending` answer with arrays of deliveries.
  return Array.isArray(value) ? value as ConsoleWebhookDelivery[] : []
}

export async function readWebhooks(signal?: AbortSignal): Promise<ConsoleWebhook[]> {
  return webhookList(await requestConsoleOperation(webhooksOperations.list, {}, signal ? { signal } : {}))
}

export async function readPendingWebhookDeliveries(signal?: AbortSignal): Promise<ConsoleWebhookDelivery[]> {
  return deliveryList(await requestConsoleOperation(webhooksOperations.pending, {}, signal ? { signal } : {}))
}

/** Which deliveries the log shows: a state, a webhook or member endpoint (`@<id>`), and a member. */
export interface ConsoleWebhookLogQuery {
  filter: ConsoleWebhookLogFilter
  webhook?: string | undefined
  owner?: string | undefined
}

/** The newest 100 deliveries that match the query. */
export async function readWebhookDeliveries(query: ConsoleWebhookLogQuery, signal?: AbortSignal): Promise<ConsoleWebhookDelivery[]> {
  const input = {
    ...query.filter === "all" ? {} : { state: query.filter },
    ...query.webhook ? { webhook: query.webhook } : {},
    ...query.owner ? { owner: query.owner } : {},
  }
  return deliveryList(await requestConsoleOperation(webhooksOperations.deliveries, input, signal ? { signal } : {}))
}

/**
 * The member endpoints, or `undefined` when the app has them off: no feature of the app uses them, or the app is older
 * than the operation.
 */
export async function readMemberEndpoints(signal?: AbortSignal): Promise<ConsoleMemberEndpoint[] | undefined> {
  try {
    const value = await requestConsoleOperation(webhooksOperations.endpoints, {}, signal ? { signal } : {})
    // SAFETY: `webhooks.endpoints` answers with an array of member endpoints.
    return Array.isArray(value) ? value as ConsoleMemberEndpoint[] : []
  }
  catch (error) {
    if (error instanceof ConsoleRequestError && (error.code === "WEBHOOKS_ENDPOINTS_OFF" || error.code === "CONSOLE_NOT_FOUND")) return undefined
    throw error
  }
}

/** Disables or enables a member endpoint. Admins cannot create or change one: only its member can. */
export async function setMemberEndpointDisabled(id: string, disabled: boolean): Promise<void> {
  await requestConsoleOperation(disabled ? webhooksOperations.disableEndpoint : webhooksOperations.enableEndpoint, { id })
}

/** The member endpoint of a delivery, when the delivery went to one that still exists. */
export function deliveryMemberEndpoint(delivery: Pick<ConsoleWebhookDelivery, "webhook">, endpoints: readonly ConsoleMemberEndpoint[]): ConsoleMemberEndpoint | undefined {
  if (!delivery.webhook.startsWith(memberWebhookPrefix)) return undefined
  const id = delivery.webhook.slice(memberWebhookPrefix.length)
  return endpoints.find(endpoint => endpoint.id === id)
}

/** The name of the member who owns an endpoint, or the owner id when the app gave no name. */
export function memberEndpointOwner(endpoint: Pick<ConsoleMemberEndpoint, "owner" | "ownerName">): string {
  return endpoint.ownerName ?? endpoint.owner
}

/**
 * The Last result cell of a member endpoint, such as `202`, `401, 3 in a row`, `In the inbox`, or `Disabled by Ana`.
 * `at` is the time to show after the label.
 */
export function memberEndpointResult(endpoint: Pick<ConsoleMemberEndpoint, "disabledAt" | "disabledBy" | "kind" | "last">): { label: string, tone: ConsoleOperationTone, at?: number } {
  if (endpoint.disabledAt !== null) return { label: endpoint.disabledBy ? `Disabled by ${endpoint.disabledBy}` : "Disabled", tone: "neutral", at: endpoint.disabledAt }
  const { last } = endpoint
  if (!last) return { label: "No sends yet", tone: "neutral" }
  if (last.state === "sent") return endpoint.kind === "inbox" || last.status === null ? { label: "In the inbox", tone: "info", at: last.at } : { label: String(last.status), tone: "success", at: last.at }
  if (last.state === "dead") {
    const reason = last.status === null ? last.error ?? "Failed" : String(last.status)
    return { label: last.failures > 1 ? `${reason}, ${last.failures} in a row` : reason, tone: "error", at: last.at }
  }
  if (last.state === "cancelled") return { label: "Cancelled", tone: "neutral", at: last.at }
  return { label: last.state === "sending" ? "Sending" : "Retry waits", tone: "warning", at: last.at }
}

/**
 * Redeliver of a delivery: a finished delivery to a webhook of the app, or a finished delivery to the Console user's
 * own member endpoint. The server refuses the member deliveries of others with 403.
 */
export function canRedeliverDelivery(delivery: Pick<ConsoleWebhookDelivery, "state" | "webhook">, endpoints: readonly ConsoleMemberEndpoint[]): boolean {
  if (!canRedeliverWebhook(delivery.state)) return false
  if (!delivery.webhook.startsWith(memberWebhookPrefix)) return true
  return deliveryMemberEndpoint(delivery, endpoints)?.mine === true
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

/** The last result of a delivery, as `webhookLastResult()`, with `In the inbox` for a delivery that an agent reads. */
export function deliveryLastResult(delivery: ConsoleWebhookDelivery, endpoints: readonly ConsoleMemberEndpoint[]): string {
  if (delivery.state === "sent" && deliveryMemberEndpoint(delivery, endpoints)?.kind === "inbox") return "In the inbox"
  return webhookLastResult(delivery)
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
