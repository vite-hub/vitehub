import { signWebhook } from "@vite-hub/env"
import { onRunFailed } from "@vite-hub/runtime/internal/run-failed"

import { isWebhookDefinition } from "./define.ts"
import { webhooksErrors } from "./errors.ts"
import { readString, serverEnv, unsealEndpoint } from "./sealing.ts"
import { resolveWebhookUrl } from "./url-guard.ts"

import type { LookupAddress } from "node:dns"
import type { Duration, Result, ResultError } from "@vite-hub/runtime"
import type { RunFailedEvent } from "@vite-hub/runtime/internal/run-failed"
import type { WebhookDefinition, WebhookEvent, WebhookSignature } from "./define.ts"
import type { ListWebhookDeliveriesOptions, MemberEndpoint, WebhookDelivery, WebhookDeliveryStore, WebhookEndpointStore, WebhooksDatabase } from "./database.ts"
import type { SendWebhookErrorCode, WebhookDeliveryErrorCode } from "./errors.ts"
import type { SendToMemberEndpointResult } from "./members.ts"
import type { EndpointTarget } from "./sealing.ts"
import type { ResolvedWebhookUrl } from "./url-guard.ts"

export { webhooksQueueName } from "./queue-name.ts"

/** Attempts of one delivery before it is `dead`: one delivery and three retries, as Cloudflare Queues does by default. */
export const webhookMaxAttempts = 4

/** How long a receiver has to answer. */
export const webhookTimeoutMs = 10_000

const claimLeaseMs = webhookTimeoutMs + 60_000

/** The Queue job of a delivery. Only the wake of the latest revision delivers, so an older wake does nothing. */
export interface WebhookWake {
  id: string
  revision: number
}

/** Sends a wake to the `vitehub-webhooks` Queue. `dynamicQueue.send()` of `@vite-hub/queue` fits. */
export type WebhookWakeSender = (wake: WebhookWake, options: { delay: Duration }) => Promise<readonly [unknown, unknown]>

/** What the generated server code of a ViteHub app passes. */
export interface InstallWebhooksOptions {
  /** The default export of each `server/webhooks/<name>.ts`, by name. */
  webhooks: Record<string, unknown>
  /** Where deliveries live: `createDrizzleWebhookStore()` from `@vite-hub/webhooks/database`. */
  store: WebhookDeliveryStore
  resolveVerifiedOwner?: (email: string, request: Request) => Promise<string | undefined>
  /**
   * Sends a wake to the Queue. Without it, which is fine for an app with only member endpoints, a member delivery that
   * fails is not tried again.
   */
  wake?: WebhookWakeSender
  /** Where member endpoints live: `createDrizzleWebhookEndpointStore()`. Without it, member endpoints are off. */
  endpoints?: WebhookEndpointStore
  /** The project-local key that the generated development registry reads. */
  developmentKey?: string
}

/** The webhooks of the running app. */
export interface InstalledWebhooks {
  webhooks: ReadonlyMap<string, WebhookDefinition>
  store: WebhookDeliveryStore
  wake: WebhookWakeSender | undefined
  endpoints: WebhookEndpointStore | undefined
  developmentKey: string | undefined
  resolveVerifiedOwner: InstallWebhooksOptions["resolveVerifiedOwner"]
}

/** One webhook, as the CLI and the Console list it. It names the variables, never their values. */
export interface WebhookInfo {
  name: string
  /** The name of the variable with the URL. */
  url: string
  /** The name of the variable with the secret. */
  secret: string
  signature: WebhookSignature
  debounceMs: number
  /** The events that ViteHub sends to this webhook by itself. */
  events: readonly WebhookEvent[]
  /** Whether this server has a value for `url` and for `secret`. */
  urlSet: boolean
  secretSet: boolean
  /** The host of the URL, such as `t3.example.com`, when it is set and valid. Never the path or the query, which can hold a token. */
  host: string | null
}

/** What `sendWebhook()` returns. `id` is the delivery: sends that a debounce collapses return the same id. */
export interface SendWebhookResult {
  id: string
  status: "pending"
}

const installedKey = Symbol.for("vitehub.webhooks.installed")

/** The webhooks that `installWebhooks()` installed in this process. */
export function installedWebhooks(): InstalledWebhooks | undefined {
  const value: unknown = Reflect.get(globalThis, installedKey)
  // SAFETY: only installWebhooks() writes this process slot.
  return value === undefined ? undefined : value as InstalledWebhooks
}

/**
 * Installs the webhooks of the app for `sendWebhook()`, the Queue handler, and the delivery functions. The generated
 * server code of a ViteHub app calls it when the server starts. A test calls it with its own store and wake sender.
 */
export function installWebhooks(options: InstallWebhooksOptions): InstalledWebhooks {
  const webhooks = new Map<string, WebhookDefinition>()
  for (const [name, definition] of Object.entries(options.webhooks)) {
    if (!isWebhookDefinition(definition)) {
      throw webhooksErrors.WEBHOOKS_DEFINITION_INVALID({ message: `[vitehub] server/webhooks/${name} must default-export defineWebhook({ url, secret }).` })
    }
    webhooks.set(name, definition)
  }
  const installed: InstalledWebhooks = { webhooks, store: options.store, wake: options.wake, endpoints: options.endpoints, developmentKey: options.developmentKey, resolveVerifiedOwner: options.resolveVerifiedOwner }
  Reflect.set(globalThis, installedKey, installed)
  if (!Reflect.get(globalThis, listenerKey)) Reflect.set(globalThis, listenerKey, onRunFailed(sendRunFailed))
  return installed
}

const listenerKey = Symbol.for("vitehub.webhooks.runFailedListener")

/**
 * The body of an event that ViteHub sends by itself, such as `workflow.failed`. `text` is one line that a person reads,
 * so a Slack incoming webhook shows it as the message.
 */
export type WebhookEventBody = RunFailedEvent & { text: string }

function failedSubject(event: RunFailedEvent): string {
  if (event.event === "invocation.failed") return event.agent ?? event.invocationId
  return event.event === "workflow.failed" ? event.workflow : event.schedule
}

function toWebhookEventBody(event: RunFailedEvent): WebhookEventBody {
  const subject = event.event === "invocation.failed"
    ? `The Agent Invocation ${event.invocationId}${event.agent ? ` of ${JSON.stringify(event.agent)}` : ""}`
    : event.event === "workflow.failed"
      ? `The Workflow run ${event.runId} of ${JSON.stringify(event.workflow)}`
      : `The Schedule run ${event.runId} of ${JSON.stringify(event.schedule)}`
  return { ...event, text: `${subject} failed: ${event.error.message}` }
}

async function sendRunFailed(event: RunFailedEvent): Promise<void> {
  const installed = installedWebhooks()
  if (!installed) return
  const body = toWebhookEventBody(event)
  for (const [name, definition] of installed.webhooks) {
    if (!definition.events.includes(event.event)) continue
    const key = definition.debounceMs > 0 ? `${event.event}:${failedSubject(event)}` : null
    const [error] = await enqueue(name, body, { event: event.event, key, delayMs: definition.debounceMs })
    if (error) console.error(`[vitehub] The webhook ${name} did not store the ${event.event} event.`, error)
  }
}

function requireInstalled(): InstalledWebhooks {
  const installed = installedWebhooks()
  if (!installed) throw webhooksErrors.WEBHOOKS_NOT_INSTALLED()
  return installed
}

/** The installed webhooks with member endpoints on. */
export function requireMemberEndpoints(): InstalledWebhooks & { endpoints: WebhookEndpointStore } {
  const installed = installedWebhooks()
  if (!installed?.endpoints) throw webhooksErrors.WEBHOOKS_ENDPOINTS_OFF()
  return { ...installed, endpoints: installed.endpoints }
}

/**
 * The Database that keeps the deliveries: the one that `useDatabase()` of `@vite-hub/database/runtime/registry` returns
 * without a name. That is the Database that `vitehub database generate` adds the table to: `default`, else the only one.
 * The registry also holds a placeholder `default` that throws, so code must not pick from it by name.
 */
export function selectDefaultDatabase(useDatabase: () => { db: WebhooksDatabase }): WebhooksDatabase {
  try {
    return useDatabase().db
  }
  catch (cause) {
    throw webhooksErrors.WEBHOOKS_DATABASE_MISSING({ cause })
  }
}

type Target = { url: string, secret: string, signature: WebhookSignature, guard?: boolean }
type TargetError = ReturnType<typeof webhooksErrors.WEBHOOKS_URL_UNSET | typeof webhooksErrors.WEBHOOKS_URL_INVALID | typeof webhooksErrors.WEBHOOKS_SECRET_UNSET>
type WakeError = ReturnType<typeof webhooksErrors.WEBHOOKS_WAKE_FAILED>

function resolveTarget(name: string, definition: WebhookDefinition): [TargetError, undefined] | [undefined, Target] {
  const env = serverEnv()
  const url = readString(env, definition.url)
  if (!url) return [webhooksErrors.WEBHOOKS_URL_UNSET({ name: definition.url, webhook: name }), undefined]
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return [webhooksErrors.WEBHOOKS_URL_INVALID({ name: definition.url, webhook: name }), undefined]
  const secret = readString(env, definition.secret)
  if (!secret) return [webhooksErrors.WEBHOOKS_SECRET_UNSET({ name: definition.secret, webhook: name }), undefined]
  return [undefined, { url, secret, signature: definition.signature }]
}

/** A member delivery names its endpoint as `@<endpoint id>` in the `webhook` column. */
export const memberWebhookPrefix = "@"

async function resolveMemberTarget(installed: InstalledWebhooks, id: string): Promise<[string, undefined] | [undefined, Target]> {
  const endpoint = await installed.endpoints?.find(id)
  if (!endpoint) return [`No member endpoint has the id ${JSON.stringify(id)}.`, undefined]
  if (endpoint.disabledAt !== null) return [`The member endpoint ${id} is disabled.`, undefined]
  if (endpoint.sealed === null) return [`The member endpoint ${id} is an inbox, so it takes no posts.`, undefined]
  const [error, target] = await unsealEndpoint({ ...endpoint, sealed: endpoint.sealed }, installed.developmentKey)
  if (error) return [error.message, undefined]
  return [undefined, { ...target, signature: "github", guard: true }]
}

/**
 * Who asks for an action on a member delivery, such as Redeliver. `id` is an app user. A ViteHub Console account is
 * not an app user, so the operation first resolves its verified email to a current app user id.
 */
export type MemberCaller = { id: string, verifiedConsoleEmail?: string }

/**
 * Whether `caller` has the app user id of the owner. Console callers must also match the email set at connect time.
 */
export function ownsMemberEndpoint(endpoint: Pick<MemberEndpoint, "owner" | "ownerEmail">, caller: MemberCaller | undefined): boolean {
  return caller?.id === endpoint.owner && (caller.verifiedConsoleEmail === undefined || caller.verifiedConsoleEmail === endpoint.ownerEmail)
}

/**
 * Posts a claimed member delivery now, or keeps it for the inbox when `target` is `undefined`. A failed post is tried
 * again through the Queue when the app has one, so its status is `"pending"`; without Queue it is `"failed"`.
 */
export async function deliverMemberClaim(installed: InstalledWebhooks, claim: WebhookDelivery, target: EndpointTarget | undefined): Promise<[WakeError, undefined] | [undefined, SendToMemberEndpointResult]> {
  const { store } = installed
  if (!target) {
    await store.sent(claim, { status: null, error: null }, Date.now())
    return [undefined, { id: claim.id, status: "inbox" }]
  }
  const result = await postDelivery(claim, { ...target, signature: "github", guard: true })
  if (result.ok) {
    await store.sent(claim, { status: result.status, error: null }, Date.now())
    return [undefined, { id: claim.id, status: "sent" }]
  }
  const retry = installed.wake !== undefined && !result.final
  const wakeError = retry ? await wake(installed, claim, webhookTimeoutMs) : undefined
  const state = await store.failed(claim, { status: result.status, error: result.failure }, Date.now(), !retry || wakeError !== undefined)
  if (wakeError) return [wakeError, undefined]
  return [undefined, { id: claim.id, status: state === "pending" ? "pending" : "failed" }]
}

export function createDeliveryId(): string {
  return `whd_${crypto.randomUUID()}`
}

export async function wake(installed: InstalledWebhooks, delivery: { id: string, revision: number, webhook: string }, delayMs: number): Promise<WakeError | undefined> {
  if (!installed.wake) return webhooksErrors.WEBHOOKS_WAKE_FAILED({ webhook: delivery.webhook, cause: new Error("The app has no Queue.") })
  try {
    const [error] = await installed.wake({ id: delivery.id, revision: delivery.revision }, { delay: `${Math.ceil(Math.max(0, delayMs) / 1000)}s` })
    return error === undefined ? undefined : webhooksErrors.WEBHOOKS_WAKE_FAILED({ webhook: delivery.webhook, cause: error })
  }
  catch (cause) {
    return webhooksErrors.WEBHOOKS_WAKE_FAILED({ webhook: delivery.webhook, cause })
  }
}

async function enqueue(name: string, body: unknown, options: { event: string, key: string | null, delayMs: number }): Promise<Result<SendWebhookResult, SendWebhookErrorCode>> {
  const installed = requireInstalled()
  const definition = installed.webhooks.get(name)
  if (!definition) throw webhooksErrors.WEBHOOKS_NOT_FOUND({ name: JSON.stringify(name) })
  const [targetError] = resolveTarget(name, definition)
  if (targetError) return [targetError, undefined]
  let text: string | undefined
  try {
    text = JSON.stringify(body)
  }
  catch {
    text = undefined
  }
  if (text === undefined) return [webhooksErrors.WEBHOOKS_BODY_INVALID({ webhook: name }), undefined]
  const now = Date.now()
  let recorded: { id: string, revision: number }
  try {
    recorded = await installed.store.record({
      id: createDeliveryId(),
      webhook: name,
      key: options.key,
      event: options.event,
      body: text,
      dueAt: now + options.delayMs,
      now,
    })
  }
  catch (error) {
    if (webhooksErrors.WEBHOOKS_STORE_FAILED.is(error) || webhooksErrors.WEBHOOKS_DATABASE_MISSING.is(error)) return [error, undefined]
    throw error
  }
  const wakeError = await wake(installed, { ...recorded, webhook: name }, options.delayMs)
  if (wakeError) return [wakeError, undefined]
  return [undefined, { id: recorded.id, status: "pending" }]
}

/** Sends a body to a webhook. `sendWebhook()` of `@vite-hub/webhooks` calls it with a typed name. */
export async function sendDynamicWebhook(name: string, body: unknown, options: { event: string, key?: string }): Promise<Result<SendWebhookResult, SendWebhookErrorCode>> {
  const debounceMs = requireInstalled().webhooks.get(name)?.debounceMs ?? 0
  return enqueue(name, body, { event: options.event, key: debounceMs > 0 ? options.key ?? name : null, delayMs: debounceMs })
}

/** The event of a test delivery. */
export const webhookTestEvent = "webhooks.test"

/**
 * Sends a test delivery to a webhook now, without its debounce and apart from the pending sends, with the event
 * `webhooks.test`. Use it to check the URL, the secret, and the receiver. The default body is
 * `{ test: true, webhook: name }`. An unknown name throws.
 */
export async function testWebhook(name: string, options: { body?: unknown } = {}): Promise<Result<SendWebhookResult, SendWebhookErrorCode>> {
  return enqueue(name, options.body === undefined ? { test: true, webhook: name } : options.body, { event: webhookTestEvent, key: null, delayMs: 0 })
}

function isWake(value: unknown): value is WebhookWake {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "id") === "string" && Number.isInteger(Reflect.get(value, "revision"))
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `no answer within ${webhookTimeoutMs / 1000} seconds`
  const cause: unknown = error instanceof Error ? error.cause : undefined
  const code = typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined
  return typeof code === "string" ? `network error ${code}` : "network error"
}

/**
 * The Queue handler of `vitehub-webhooks`. It posts the delivery of a wake when the wake carries the latest revision and
 * the delivery is pending. A 2xx answer marks it `sent`. Any other answer throws, so the Queue tries again, until the
 * last attempt marks it `dead`. A wake that is out of date does nothing.
 */
export async function deliverWebhookWake(payload: unknown): Promise<void> {
  if (!isWake(payload)) {
    console.error("[vitehub] The webhooks Queue got a job that is not a delivery wake. It skips the job.")
    return
  }
  const installed = requireInstalled()
  const { store } = installed
  const now = Date.now()
  const claim = await store.claim(payload.id, payload.revision, now, now - claimLeaseMs)
  if (!claim) {
    const current = await store.get(payload.id)
    if (current?.revision === payload.revision && current.state === "sending") {
      const error = await wake(installed, current, current.updatedAt + claimLeaseMs + 1 - Date.now())
      if (error) throw error
    }
    return
  }
  const [targetError, target] = claim.webhook.startsWith(memberWebhookPrefix)
    ? await resolveMemberTarget(installed, claim.webhook.slice(memberWebhookPrefix.length))
    : resolveFileTarget(installed, claim.webhook)
  if (targetError !== undefined) {
    await store.failed(claim, { status: null, error: targetError }, Date.now(), true)
    return
  }
  const result = await postDelivery(claim, target)
  if (result.ok) {
    await store.sent(claim, { status: result.status, error: null }, Date.now())
    return
  }
  const dead = result.final || claim.attempts >= webhookMaxAttempts
  const state = await store.failed(claim, { status: result.status, error: result.failure }, Date.now(), dead)
  if (state === "pending") throw webhooksErrors.WEBHOOKS_DELIVERY_FAILED({ reason: result.failure, webhook: claim.webhook })
}

function resolveFileTarget(installed: InstalledWebhooks, name: string): [string, undefined] | [undefined, Target] {
  const definition = installed.webhooks.get(name)
  if (!definition) return [`No webhook is named ${JSON.stringify(name)} in this build.`, undefined]
  const [error, target] = resolveTarget(name, definition)
  return error ? [error.message, undefined] : [undefined, target]
}

/** One attempt. `final` means a retry cannot help, such as a URL that the guard refuses. */
export type PostResult =
  | { ok: true, status: number }
  | { ok: false, status: number | null, failure: string, final: boolean }

async function postWithCheckedAddresses(url: URL, addresses: LookupAddress[], body: string, headers: Record<string, string>, signal: AbortSignal): Promise<number> {
  const { request } = await import("node:https")
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      agent: false,
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      signal,
      lookup(_hostname, options, callback) {
        const candidates = addresses.filter(address => !options.family || address.family === options.family)
        const first = candidates[0]
        if (!first) callback(new Error("No checked address matches the requested family."), "", 0)
        else if (options.all) callback(null, candidates)
        else callback(null, first.address, first.family)
      },
    }, (response) => {
      const status = response.statusCode ?? 0
      response.destroy()
      resolve(status)
    })
    outgoing.on("error", reject)
    outgoing.end(body)
  })
}

/** Posts a claimed delivery once, signed, with a 10 second timeout and no redirects. */
export async function postDelivery(claim: WebhookDelivery, target: Target): Promise<PostResult> {
  let checked: ResolvedWebhookUrl | undefined
  if (target.guard) {
    const [refused, resolved] = await resolveWebhookUrl(target.url)
    if (refused) return { ok: false, status: null, failure: refused.message, final: true }
    checked = resolved
  }
  const body = JSON.stringify(claim.body)
  try {
    const signed = await signWebhook(body, { provider: target.signature, secret: target.secret })
    const headers = {
      ...signed,
      "content-type": "application/json",
      "user-agent": "ViteHub-Webhooks",
      "x-vitehub-delivery": claim.id,
      "x-vitehub-event": claim.event,
      "x-vitehub-events": String(claim.count),
    }
    const signal = AbortSignal.timeout(webhookTimeoutMs)
    let status: number
    if (checked?.addresses) {
      status = await postWithCheckedAddresses(checked.url, checked.addresses, body, headers, signal)
    }
    else {
      const response = await fetch(checked?.url ?? target.url, { method: "POST", body, headers, redirect: "manual", signal })
      await response.body?.cancel().catch(() => {})
      status = response.status
    }
    return status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, failure: `HTTP ${status}`, final: false }
  }
  catch (error) {
    return { ok: false, status: null, failure: describeFailure(error), final: false }
  }
}

const deliveryErrorCodes: readonly string[] = [
  "WEBHOOKS_DATABASE_MISSING",
  "WEBHOOKS_DELIVERY_ACTIVE",
  "WEBHOOKS_DELIVERY_NOT_FOUND",
  "WEBHOOKS_DELIVERY_NOT_OWNER",
  "WEBHOOKS_DELIVERY_NOT_PENDING",
  "WEBHOOKS_ENDPOINT_DISABLED",
  "WEBHOOKS_ENDPOINT_NOT_FOUND",
  "WEBHOOKS_KEY_INVALID",
  "WEBHOOKS_KEY_UNSET",
  "WEBHOOKS_STORE_FAILED",
  "WEBHOOKS_WAKE_FAILED",
] satisfies readonly WebhookDeliveryErrorCode[]

function isDeliveryError(error: unknown): error is ResultError<WebhookDeliveryErrorCode> {
  return webhooksErrors.is(error) && deliveryErrorCodes.includes(error.code)
}

async function attempt<T>(run: (installed: InstalledWebhooks) => Promise<T>): Promise<Result<T, WebhookDeliveryErrorCode>> {
  const installed = requireInstalled()
  try {
    return [undefined, await run(installed)]
  }
  catch (error) {
    if (isDeliveryError(error)) return [error, undefined]
    throw error
  }
}

/** Every webhook of the app, with the names of its variables and whether they are set. */
export function listWebhooks(): WebhookInfo[] {
  const installed = requireInstalled()
  const env = serverEnv()
  return [...installed.webhooks].sort(([left], [right]) => left.localeCompare(right)).map(([name, definition]) => {
    const url = readString(env, definition.url)
    return {
      name,
      url: definition.url,
      secret: definition.secret,
      signature: definition.signature,
      debounceMs: definition.debounceMs,
      events: definition.events,
      urlSet: url !== undefined,
      secretSet: readString(env, definition.secret) !== undefined,
      host: url !== undefined && URL.canParse(url) ? new URL(url).host || null : null,
    }
  })
}

/** Deliveries, newest first. */
export function listWebhookDeliveries(options?: ListWebhookDeliveriesOptions): Promise<Result<WebhookDelivery[], WebhookDeliveryErrorCode>> {
  return attempt(installed => installed.store.list(options))
}

/** Pending deliveries, the soonest due first: the debounce timers that run now. */
export function listPendingWebhookDeliveries(options?: { webhook?: string, limit?: number }): Promise<Result<WebhookDelivery[], WebhookDeliveryErrorCode>> {
  return attempt(installed => installed.store.pending(options))
}

async function findDelivery(installed: InstalledWebhooks, id: string): Promise<WebhookDelivery> {
  const delivery = await installed.store.get(id)
  if (!delivery) throw webhooksErrors.WEBHOOKS_DELIVERY_NOT_FOUND({ id: JSON.stringify(id) })
  return delivery
}

export function getWebhookDelivery(id: string): Promise<Result<WebhookDelivery, WebhookDeliveryErrorCode>> {
  return attempt(installed => findDelivery(installed, id))
}

/** What the delivery functions that send take. */
export interface WebhookDeliveryActionOptions {
  /** Who asks. A delivery to a member endpoint goes out again only for its owner: see `ownsMemberEndpoint()`. */
  caller?: MemberCaller
  resolveCaller?: () => Promise<MemberCaller | undefined>
}

/** The member endpoint of a member delivery, when `caller` owns it. Throws the error that the action returns. */
async function ownedMemberEndpoint(installed: InstalledWebhooks, delivery: WebhookDelivery, options: WebhookDeliveryActionOptions) {
  const id = delivery.webhook.slice(memberWebhookPrefix.length)
  const endpoint = await installed.endpoints?.find(id)
  if (!endpoint) throw webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: `the id ${JSON.stringify(id)}` })
  if (!ownsMemberEndpoint(endpoint, options.resolveCaller ? await options.resolveCaller() : options.caller)) {
    throw webhooksErrors.WEBHOOKS_DELIVERY_NOT_OWNER({ id: JSON.stringify(delivery.id) })
  }
  return endpoint
}

/**
 * Delivers a pending delivery now, without the rest of its debounce. A pending member delivery, which waits for a
 * Queue retry, goes out only for its owner, so pass `caller`.
 */
export function flushWebhookDelivery(id: string, options: WebhookDeliveryActionOptions = {}): Promise<Result<WebhookDelivery, WebhookDeliveryErrorCode>> {
  return attempt(async (installed) => {
    const current = await findDelivery(installed, id)
    if (current.webhook.startsWith(memberWebhookPrefix)) {
      const endpoint = await ownedMemberEndpoint(installed, current, options)
      if (endpoint.disabledAt !== null) throw webhooksErrors.WEBHOOKS_ENDPOINT_DISABLED({ id: endpoint.id })
    }
    const delivery = await installed.store.due(id, Date.now())
    if (!delivery) {
      const current = await findDelivery(installed, id)
      throw webhooksErrors.WEBHOOKS_DELIVERY_NOT_PENDING({ id: JSON.stringify(id), state: current.state })
    }
    const error = await wake(installed, delivery, 0)
    if (error) throw error
    return delivery
  })
}

/** Cancels a pending delivery. Its wake then does nothing. */
export function cancelWebhookDelivery(id: string): Promise<Result<WebhookDelivery, WebhookDeliveryErrorCode>> {
  return attempt(async (installed) => {
    const delivery = await installed.store.cancel(id, Date.now())
    if (delivery) return delivery
    const current = await findDelivery(installed, id)
    throw webhooksErrors.WEBHOOKS_DELIVERY_NOT_PENDING({ id: JSON.stringify(id), state: current.state })
  })
}

/**
 * Sends a sent, dead, or cancelled delivery again, now, as a new delivery with a new id. It keeps the body, the event,
 * and the count. The webhook must still exist.
 *
 * A delivery to a member endpoint goes out again only for the owner of the endpoint, so pass `caller`. Anyone else gets
 * `WEBHOOKS_DELIVERY_NOT_OWNER`. It posts in the request, as `sendToMemberEndpoint()` does, and returns its status.
 */
export function redeliverWebhookDelivery(id: string, options: WebhookDeliveryActionOptions = {}): Promise<Result<SendWebhookResult | SendToMemberEndpointResult, WebhookDeliveryErrorCode>> {
  return attempt(async (installed): Promise<SendWebhookResult | SendToMemberEndpointResult> => {
    const source = await findDelivery(installed, id)
    const endpoint = source.webhook.startsWith(memberWebhookPrefix) ? await ownedMemberEndpoint(installed, source, options) : undefined
    if (source.state === "pending" || source.state === "sending") throw webhooksErrors.WEBHOOKS_DELIVERY_ACTIVE({ id: JSON.stringify(id), state: source.state })
    if (endpoint) return await redeliverToMember(installed, source, endpoint)
    if (!installed.webhooks.has(source.webhook)) throw webhooksErrors.WEBHOOKS_NOT_FOUND({ name: JSON.stringify(source.webhook) })
    const now = Date.now()
    const recorded = await installed.store.record({ id: createDeliveryId(), webhook: source.webhook, key: null, event: source.event, body: JSON.stringify(source.body), count: source.count, dueAt: now, now })
    const error = await wake(installed, { ...recorded, webhook: source.webhook }, 0)
    if (error) throw error
    return { id: recorded.id, status: "pending" as const }
  })
}

async function redeliverToMember(installed: InstalledWebhooks, source: WebhookDelivery, endpoint: MemberEndpoint & { sealed: string | null }): Promise<SendToMemberEndpointResult> {
  if (endpoint.disabledAt !== null) throw webhooksErrors.WEBHOOKS_ENDPOINT_DISABLED({ id: endpoint.id })
  let target: EndpointTarget | undefined
  if (endpoint.sealed !== null) {
    const [keyError, opened] = await unsealEndpoint({ ...endpoint, sealed: endpoint.sealed }, installed.developmentKey)
    if (keyError) throw keyError
    target = opened
  }
  const now = Date.now()
  const recorded = await installed.store.record({ id: createDeliveryId(), webhook: source.webhook, owner: endpoint.owner, key: null, event: source.event, body: JSON.stringify(source.body), count: source.count, dueAt: now, now })
  // `0` claims only a pending delivery, never one that another server is sending.
  const claim = await installed.store.claim(recorded.id, recorded.revision, now, 0)
  if (!claim) return { id: recorded.id, status: "pending" }
  const [wakeError, result] = await deliverMemberClaim(installed, claim, target)
  if (wakeError) throw wakeError
  return result
}
