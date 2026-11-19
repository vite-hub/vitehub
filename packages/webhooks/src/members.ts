import { webhooksErrors } from "./errors.ts"
import { sealEndpoint, unsealEndpoint } from "./sealing.ts"
import { checkWebhookUrl } from "./url-guard.ts"
import { createDeliveryId, deliverMemberClaim, memberWebhookPrefix, requireMemberEndpoints } from "./runtime.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { MemberEndpoint, MemberLastDelivery, StoredMemberEndpoint } from "./database.ts"
import type { CreateMemberEndpointErrorCode, MemberEndpointErrorCode, SendToMemberEndpointErrorCode } from "./errors.ts"

/** The hosts that a member endpoint URL may use when `createMemberEndpoint()` gets no `hosts`: the T3 Code relay. */
export const memberEndpointHosts: readonly string[] = ["relay.t3.codes"]

/** What `createMemberEndpoint()` accepts. */
export type CreateMemberEndpointOptions = {
  /** The member, such as the Auth user id. A member has one endpoint: a new one replaces the old one. */
  owner: string
  /** The name of the member that admins read in the Console, such as `"Ana Ruiz"`. */
  ownerName?: string
  /**
   * The email of the member, only when it is verified. The ViteHub Console signs in with its own accounts, so a Console
   * account acts as the owner, such as for Redeliver, when its email equals this one.
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
}

/**
 * What `sendToMemberEndpoint()` returns. `status` is `"sent"` when the receiver answered 2xx, `"inbox"` when the
 * delivery waits in an inbox, `"pending"` when the Queue tries again, and `"failed"` when it was not delivered.
 */
export interface SendToMemberEndpointResult {
  id: string
  status: "sent" | "inbox" | "pending" | "failed"
}

const limits = { owner: 256, name: 120, agent: 64, email: 320, secret: 1024, url: 2048 }

function toMemberEndpoint({ sealed: _sealed, ...endpoint }: StoredMemberEndpoint): MemberEndpoint {
  return endpoint
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
 * A member has one endpoint: a new one replaces the old one, and its id changes.
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
  const { endpoints } = requireMemberEndpoints()
  const problem = text(options?.owner, "owner", limits.owner) ?? text(options.name, "name", limits.name)
    ?? (options.agent === undefined ? undefined : text(options.agent, "agent", limits.agent))
    ?? (options.ownerName === undefined ? undefined : text(options.ownerName, "ownerName", limits.name))
    ?? (options.ownerEmail === undefined ? undefined : text(options.ownerEmail, "ownerEmail", limits.email))
  if (problem) return invalid(problem)
  // The options can come from a request body, so check the kind at runtime too.
  const kind: unknown = options.kind
  if (kind !== "url" && kind !== "inbox") return invalid(`\`kind\` must be "url" or "inbox", not ${JSON.stringify(kind)}`)
  const now = Date.now()
  const endpoint: StoredMemberEndpoint = {
    id: `whe_${crypto.randomUUID()}`,
    owner: options.owner,
    ownerName: options.ownerName?.trim() ?? null,
    ownerEmail: options.ownerEmail?.trim().toLowerCase() ?? null,
    name: options.name.trim(),
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
    const [keyError, sealed] = await sealEndpoint(endpoint, { url: url.href, secret: options.secret })
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

/** The endpoint of a member, or `null` when they have none, as `[error, endpoint]`. It never holds the URL or the secret. */
export async function getMemberEndpoint(owner: string): Promise<Result<MemberEndpoint | null, MemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const endpoint = await endpoints.get(owner)
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

/** A member endpoint with the newest delivery to it, as the Console lists them. */
export interface MemberEndpointWithLastDelivery extends MemberEndpoint {
  /** The newest delivery to the endpoint, or `null` before the first send. */
  last: MemberLastDelivery | null
}

/**
 * Every member endpoint, the oldest first, with the newest delivery to each, as `[error, endpoints]`. The rows never
 * hold the URL or the secret. Check that the caller may read them, such as an admin, before you call it.
 */
export async function listMemberEndpoints(options: { limit?: number } = {}): Promise<Result<MemberEndpointWithLastDelivery[], MemberEndpointErrorCode>> {
  const { endpoints, store } = requireMemberEndpoints()
  try {
    const [rows, results] = await Promise.all([endpoints.list(options), store.memberResults()])
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
    const endpoint = await installed.endpoints.get(owner)
    if (!endpoint) return [webhooksErrors.WEBHOOKS_ENDPOINT_NOT_FOUND({ match: `the owner ${JSON.stringify(owner)}` }), undefined]
    if (endpoint.disabledAt !== null) return [webhooksErrors.WEBHOOKS_ENDPOINT_DISABLED({ id: endpoint.id }), undefined]
    let target: { url: string, secret: string } | undefined
    if (endpoint.sealed !== null) {
      const [keyError, opened] = await unsealEndpoint({ ...endpoint, sealed: endpoint.sealed })
      if (keyError) return [keyError, undefined]
      target = opened
    }
    const now = Date.now()
    const recorded = await store.recordOnce({ id: createDeliveryId(), webhook: `${memberWebhookPrefix}${endpoint.id}`, key: options.key, event: options.event, body: json, dueAt: now, now })
    const done = target ? "sent" : "inbox"
    if (!recorded.created) return [undefined, { id: recorded.id, status: recorded.state === "sent" ? done : "pending" }]
    // `0` claims only a pending delivery, never one that another server is sending.
    const claim = await store.claim(recorded.id, recorded.revision, now, 0)
    // Another server, such as a Queue flush, claimed it first.
    if (!claim) return [undefined, { id: recorded.id, status: "pending" }]
    return await deliverMemberClaim(installed, claim, target)
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}
