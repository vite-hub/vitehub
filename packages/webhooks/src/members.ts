import { webhooksErrors } from "./errors.ts"
import { memberBodyLabel, sealedMemberBodyPrefix, sealEndpoint, sealWebhooksText, unsealEndpoint } from "./sealing.ts"
import { checkWebhookUrl, outsideHosts } from "./url-guard.ts"
import { createDeliveryId, deliverMemberClaim, inspectDelivery, memberWebhookPrefix, requireMemberEndpoints } from "./runtime.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { ListMemberEndpointsOptions, ListWebhookDeliveriesOptions, MemberEndpoint, MemberLastDelivery, StoredMemberEndpoint, WebhookDelivery, WebhookDeliveryState } from "./database.ts"
import type { CreateMemberEndpointErrorCode, MemberEndpointErrorCode, SendToMemberEndpointErrorCode } from "./errors.ts"

/** The hosts that a member endpoint URL may use when `createMemberEndpoint()` gets no `hosts`: the T3 Code relay. */
export const memberEndpointHosts: readonly string[] = ["relay.t3.codes"]

/** What `createMemberEndpoint()` accepts. */
export type CreateMemberEndpointOptions = {
  /** The member, such as the Auth user id. A member has one endpoint per `address`: a new one replaces the old one. */
  owner: string
  /**
   * Where the agent can be reached, such as the T3 thread link `t3-thread://v2/<environment>/<thread>` it paired from.
   * A send with this `address` reaches this endpoint. Without it, the endpoint has none.
   */
  address?: string
  /** The name of the member that admins read in the Console, such as `"Ana Ruiz"`. */
  ownerName?: string
  /**
   * The email of the member, only when it is verified. The ViteHub Console signs in with its own accounts, so a Console
   * account acts as the owner only when its verified email equals this one and Auth still resolves it to `owner`.
   */
  ownerEmail?: string
  /** A name that people read, such as `"Launch plan thread"`. */
  name: string
  /** The agent that receives, such as `"t3"`, `"claude-code"`, or `"codex"`. */
  agent?: string
} & ({
  /** Webhooks posts each send to `url`, signed with `secret` as `x-hub-signature-256`. */
  kind: "url"
  url: string
  secret: string
  /** The hosts that `url` may use. Default: `memberEndpointHosts`, the T3 Code relay. */
  hosts?: readonly string[]
} | {
  /** Webhooks posts nothing. The member's agent reads the deliveries, such as through an MCP tool. */
  kind: "inbox"
})

/** Options of `sendToMemberEndpoint()`. */
export interface SendToMemberEndpointOptions {
  /** A label for the receiver, sent as `x-vitehub-event`, such as `"comments.send"`. */
  event: string
  /**
   * The idempotency key, such as the ids of the comments that the send holds. A send with the key of a pending,
   * sending, or sent delivery of the same endpoint returns that delivery and posts nothing.
   */
  key: string
  /**
   * The address of the agent that should get the send, such as the T3 thread that wrote what the comments are on. The
   * member's endpoint with this address gets it; without one, their newest endpoint does.
   */
  address?: string
  /** Send only to this endpoint of the member, with no address or newest-endpoint fallback. */
  endpointId?: string
  /**
   * The hosts that the endpoint's URL may use now, such as the current `hosts` of the app. A URL endpoint on another
   * host gets `WEBHOOKS_URL_REFUSED` and no delivery, so narrowing the list also stops endpoints that it allowed before.
   */
  hosts?: readonly string[]
  /** Seal the body at rest and omit it from delivery inspection. */
  sealBody?: boolean
  /** A preallocated unique delivery ID, for correlating a durable record before sending. */
  deliveryId?: string
}

/**
 * What `sendToMemberEndpoint()` returns. `status` is `"sent"` when the receiver answered 2xx, `"inbox"` when the
 * delivery waits in an inbox, `"pending"` when the Queue tries again, and `"failed"` when it was not delivered.
 */
export interface SendToMemberEndpointResult {
  id: string
  status: "sent" | "inbox" | "pending" | "failed"
}

const limits = { owner: 256, name: 120, agent: 64, email: 320, secret: 1024, url: 2048, address: 512 }

function toMemberEndpoint({ sealed: _sealed, address, ...endpoint }: StoredMemberEndpoint): MemberEndpoint {
  return { ...endpoint, address: address || null }
}

function storeError(error: unknown): ResultError<"WEBHOOKS_DATABASE_MISSING" | "WEBHOOKS_STORE_FAILED"> {
  if (webhooksErrors.WEBHOOKS_STORE_FAILED.is(error) || webhooksErrors.WEBHOOKS_DATABASE_MISSING.is(error)) return error
  throw error
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return `\`${field}\` must be non-empty text`
  if (value.length > max) return `\`${field}\` must be at most ${max} characters`
  return undefined
}

function invalid(problem: string): [ResultError<"WEBHOOKS_ENDPOINT_INVALID">, undefined] {
  return [webhooksErrors.WEBHOOKS_ENDPOINT_INVALID({ problem }), undefined]
}

/**
 * Creates the endpoint of a member, so `sendToMemberEndpoint(owner, ...)` reaches their own agent, and returns
 * `[error, endpoint]`. A `"url"` endpoint must pass `checkWebhookUrl()` with `hosts`, which defaults to the T3 Code
 * relay. Webhooks seals the URL and secret with `VITEHUB_WEBHOOKS_KEY` before it stores them, and returns only the host.
 * A member has one endpoint per `address`: a new one replaces the one with the same address, and its id changes.
 *
 * ```ts
 * import { createMemberEndpoint } from "@vite-hub/webhooks"
 *
 * const [error, endpoint] = await createMemberEndpoint({
 *   owner: "user_ana",
 *   name: "Launch plan thread",
 *   agent: "t3",
 *   kind: "url",
 *   url: "https://relay.t3.codes/hooks/abc123",
 *   secret: "whsec_9f2c",
 * })
 * ```
 */
export async function createMemberEndpoint(options: CreateMemberEndpointOptions): Promise<Result<MemberEndpoint, CreateMemberEndpointErrorCode>> {
  const { endpoints, developmentKey } = requireMemberEndpoints()
  const problem = text(options?.owner, "owner", limits.owner) ?? text(options.name, "name", limits.name)
    ?? (options.agent === undefined ? undefined : text(options.agent, "agent", limits.agent))
    ?? (options.ownerName === undefined ? undefined : text(options.ownerName, "ownerName", limits.name))
    ?? (options.ownerEmail === undefined ? undefined : text(options.ownerEmail, "ownerEmail", limits.email))
    ?? (options.address === undefined ? undefined : text(options.address, "address", limits.address))
  if (problem) return invalid(problem)
  const kind: unknown = options.kind
  if (kind !== "url" && kind !== "inbox") return invalid(`\`kind\` must be "url" or "inbox", not ${JSON.stringify(kind)}`)
  const now = Date.now()
  const endpoint: StoredMemberEndpoint = {
    id: `whe_${crypto.randomUUID()}`,
    owner: options.owner,
    ownerName: options.ownerName?.trim() ?? null,
    ownerEmail: options.ownerEmail?.trim().toLowerCase() ?? null,
    name: options.name.trim(),
    address: options.address?.trim() ?? "",
    kind: options.kind,
    agent: options.agent?.trim() ?? null,
    host: null,
    sealed: null,
    disabledAt: null,
    disabledBy: null,
    createdAt: now,
    updatedAt: now,
  }
  if (options.kind === "url") {
    const urlProblem = text(options.url, "url", limits.url) ?? text(options.secret, "secret", limits.secret)
    if (urlProblem) return invalid(urlProblem)
    const [refused, url] = await checkWebhookUrl(options.url, { hosts: options.hosts ?? memberEndpointHosts })
    if (refused) return [refused, undefined]
    const [keyError, sealed] = await sealEndpoint(endpoint, { url: url.href, secret: options.secret }, developmentKey)
    if (keyError) return [keyError, undefined]
    endpoint.host = url.host
    endpoint.sealed = sealed
  }
  try {
    await endpoints.put(endpoint)
  }
  catch (error) {
    return [storeError(error), undefined]
  }
  return [undefined, toMemberEndpoint(endpoint)]
}

/**
 * The endpoint that a send to a member reaches, or `null` when they have none, as `[error, endpoint]`: the one with
 * `endpointId` or `address`, else their newest. It never holds the URL or the secret.
 */
export async function getMemberEndpoint(owner: string, options: { address?: string, endpointId?: string } = {}): Promise<Result<MemberEndpoint | null, MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const endpoint = await selectEndpoint(endpoints, owner, options)
    return [undefined, endpoint ? toMemberEndpoint(endpoint) : null]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** Removes the endpoint `id` of a member. Another member's endpoint gives `WEBHOOKS_ENDPOINT_NOT_FOUND`. */
export async function removeMemberEndpoint(owner: string, id: string): Promise<Result<MemberEndpoint, MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const endpoint = await endpoints.remove(owner, id)
    return endpoint ? [undefined, toMemberEndpoint(endpoint)] : [webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: `the id ${JSON.stringify(id)} and the owner ${JSON.stringify(owner)}` }), undefined]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/**
 * Removes every endpoint of a member, such as when they disconnect their agents, and returns `[error, removed]`. A member
 * with no endpoint gets an empty list.
 */
export async function removeMemberEndpoints(owner: string): Promise<Result<MemberEndpoint[], MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    return [undefined, (await endpoints.removeAll(owner)).map(toMemberEndpoint)]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** A member endpoint with the newest delivery to it, as the Console lists them. */
export interface MemberEndpointWithLastDelivery extends MemberEndpoint {
  /** The newest delivery to the endpoint, or `null` before the first send. */
  last: MemberLastDelivery | null
}

/**
 * A page of member endpoints, the oldest first, with the newest delivery to each, as `[error, endpoints]`. The rows never
 * hold the URL or the secret. Check that the caller may read them, such as an admin, before you call it.
 */
export async function listMemberEndpoints(options: ListMemberEndpointsOptions = {}): Promise<Result<MemberEndpointWithLastDelivery[], MemberEndpointErrorCode>> {
  const { endpoints, store } = requireMemberEndpoints()
  try {
    const rows = await endpoints.list(options)
    const results = await store.memberResults(rows.map(row => `${memberWebhookPrefix}${row.id}`))
    return [undefined, rows.map(row => ({ ...toMemberEndpoint(row), last: results.get(`${memberWebhookPrefix}${row.id}`) ?? null }))]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/**
 * Disables a member endpoint, so it gets no more sends, without the owner. `by` names who did it, such as the admin,
 * for the Console. Check that the caller may do this before you call it. `enableMemberEndpoint()` undoes it, and so
 * does the member when they connect their agent again.
 */
export async function disableMemberEndpoint(id: string, options: { by?: string } = {}): Promise<Result<MemberEndpoint, MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const endpoint = await endpoints.disable(id, Date.now(), options.by?.trim() || null)
    return endpoint ? [undefined, toMemberEndpoint(endpoint)] : [webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: `the id ${JSON.stringify(id)}` }), undefined]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** Enables a member endpoint that an admin disabled, so it gets sends again. Check that the caller may do this first. */
export async function enableMemberEndpoint(id: string): Promise<Result<MemberEndpoint, MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const endpoint = await endpoints.enable(id, Date.now())
    return endpoint ? [undefined, toMemberEndpoint(endpoint)] : [webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: `the id ${JSON.stringify(id)}` }), undefined]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/**
 * Sends `body` as JSON to the endpoint of a member and returns `[error, { id, status }]`. It posts in the request,
 * with a 10 second timeout and the same headers and signature as `sendWebhook()`, so it needs no Queue. When the app
 * has Queue, a failed post is tried again through it, and `status` is `"pending"`. Without Queue, it is `"failed"`.
 *
 * A send with the `key` of a pending, sending, or sent delivery returns that delivery and posts nothing.
 *
 * ```ts
 * import { sendToMemberEndpoint } from "@vite-hub/webhooks"
 *
 * const [error, sent] = await sendToMemberEndpoint("user_ana", { threads: ["thr_1", "thr_2"] }, {
 *   event: "comments.send",
 *   key: "thr_1:msg_8,thr_2:msg_3",
 * })
 * ```
 */
export async function sendToMemberEndpoint(owner: string, body: unknown, options: SendToMemberEndpointOptions): Promise<Result<SendToMemberEndpointResult, SendToMemberEndpointErrorCode>> {
  const installed = requireMemberEndpoints()
  const { store } = installed
  let json: string | undefined
  try {
    json = JSON.stringify(body)
  }
  catch {
    json = undefined
  }
  if (json === undefined) return [webhooksErrors.WEBHOOKS_BODY_INVALID({ webhook: `of the member ${JSON.stringify(owner)}` }), undefined]
  try {
    const endpoint = await selectEndpoint(installed.endpoints, owner, options)
    if (!endpoint) return [webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: options.endpointId === undefined ? `the owner ${JSON.stringify(owner)}` : JSON.stringify(options.endpointId) }), undefined]
    if (endpoint.disabledAt !== null) return [webhooksErrors.WEBHOOKS_ENDPOINT_DISABLED({ id: endpoint.id }), undefined]
    let target: { url: string, secret: string } | undefined
    if (endpoint.sealed !== null) {
      const [keyError, opened] = await unsealEndpoint({ ...endpoint, sealed: endpoint.sealed }, installed.developmentKey)
      if (keyError) return [keyError, undefined]
      const outside = options.hosts && outsideHosts(new URL(opened.url), options.hosts)
      if (outside) return [webhooksErrors.WEBHOOKS_URL_REFUSED({ reason: outside }), undefined]
      target = opened
    }
    const webhook = `${memberWebhookPrefix}${endpoint.id}`
    if (options.sealBody) {
      const [error, sealed] = await sealWebhooksText(memberBodyLabel(webhook, options.event), json, installed.developmentKey)
      if (error) return [error, undefined]
      json = JSON.stringify(`${sealedMemberBodyPrefix}${sealed}`)
    }
    const now = Date.now()
    const recorded = await store.recordOnce({ id: options.deliveryId ?? createDeliveryId(), webhook, owner: endpoint.owner, key: options.key, event: options.event, body: json, dueAt: now, now })
    const done = target ? "sent" : "inbox"
    if (!recorded.created) return [undefined, { id: recorded.id, status: recorded.state === "sent" ? done : "pending" }]
    const claim = await store.claim(recorded.id, recorded.revision, now, 0)
    if (!claim) return [undefined, { id: recorded.id, status: "pending" }]
    return await deliverMemberClaim(installed, claim, target)
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** What `listMemberDeliveries()` returns: the endpoint it read, and its deliveries, the newest first. */
export interface MemberDeliveries {
  endpoint: MemberEndpoint
  deliveries: WebhookDelivery[]
}

async function selectEndpoint(endpoints: ReturnType<typeof requireMemberEndpoints>["endpoints"], owner: string, options: { address?: string, endpointId?: string }): Promise<StoredMemberEndpoint | undefined> {
  if (options.endpointId === undefined) return endpoints.get(owner, options.address)
  const endpoint = await endpoints.find(options.endpointId)
  return endpoint?.owner === owner ? endpoint : undefined
}

/**
 * The deliveries to the endpoint that a send to the member with `address` reaches, the newest first, as
 * `[error, { endpoint, deliveries }]`, or `null` when the member has no endpoint. An agent that pairs as an inbox reads
 * its sends here: pass its `endpointId` for an exact lookup with no fallback, and the last delivery as `before` for
 * the next page. An empty `address` prefers the unaddressed endpoint. Check that the caller acts as `owner` first.
 * Sealed bodies are omitted, as in the delivery log.
 *
 * ```ts
 * import { listMemberDeliveries } from "@vite-hub/webhooks"
 *
 * const [error, inbox] = await listMemberDeliveries("user_ana", { limit: 20 })
 * ```
 */
export async function listMemberDeliveries(owner: string, options: { address?: string, endpointId?: string } & Pick<ListWebhookDeliveriesOptions, "limit" | "before"> = {}): Promise<Result<MemberDeliveries | null, MemberEndpointErrorCode>> {
  const { endpoints, store } = requireMemberEndpoints()
  try {
    const endpoint = await selectEndpoint(endpoints, owner, options)
    if (!endpoint) return [undefined, null]
    const deliveries = await store.list({ webhook: `${memberWebhookPrefix}${endpoint.id}`, limit: options.limit, before: options.before })
    return [undefined, { endpoint: toMemberEndpoint(endpoint), deliveries: deliveries.map(inspectDelivery) }]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** Reads only the state of a known member delivery, never its body. */
export async function getMemberDeliveryState(id: string): Promise<WebhookDeliveryState | undefined> {
  return (await getMemberDelivery(id))?.state
}

/**
 * Reads the state of a known member delivery, and whether it waits in an inbox, never its body. `inbox` stays true after
 * the member removes the endpoint, so it tells where an old delivery went.
 */
export async function getMemberDelivery(id: string): Promise<{ state: WebhookDeliveryState, inbox: boolean } | undefined> {
  const row = await requireMemberEndpoints().store.get(id)
  if (!row?.webhook.startsWith(memberWebhookPrefix)) return undefined
  return { state: row.state, inbox: row.state === "sent" && row.lastStatus === null }
}
