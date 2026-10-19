import type { StateAdapter } from "chat"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../internal/runtime-value.ts"

/** A webhook gets an answer within this many milliseconds of its arrival, once its request is stored. */
export const defaultWebhookAckTimeoutMs = 5_000
/** A stored request that no process admitted is kept for one day. */
const webhookInboxRetentionMs = 86_400_000
/** The route admits a stored request at most this many times, the first delivery included. */
const webhookInboxMaxAttempts = 3

/** Admissions that got a 202 answer and still run. `drainDeferredWebhookAdmissions()` waits for them. */
const deferredWebhookAdmissions = new Set<Promise<void>>()

export interface WebhookInboxState {
  keyPrefix: string
  state: StateAdapter
}

export interface WebhookInboxRequest {
  body: string
  headers: Record<string, string>
  method: string
  url: string
}

interface WebhookInboxEntry {
  id: string
  receivedAt: string
  request: WebhookInboxRequest
  webhookId: string
}

interface StoredWebhookInboxEntry extends WebhookInboxEntry {
  attempts: number
}

export interface WebhookInbox {
  attempts: number
  id: string
  /** Another request currently owns admission for this delivery. */
  duplicate?: boolean
  /** Removes the stored request. Admission has settled, so a restart must not replay it. */
  settle(): Promise<void>
  /** Releases admission ownership while retaining the row for replay. */
  release(): Promise<void>
}

export interface WebhookInboxLogFields {
  agentName: string
  channelId?: string
  deliveryScope: string
  provider: string
}

export interface DrainDeferredWebhookAdmissionsOptions {
  /** How long to wait in milliseconds. Defaults to 0, which only counts the admissions. */
  timeoutMs?: number
}

export interface DrainDeferredWebhookAdmissionsResult {
  /** Admissions that were running when the drain started. */
  pending: number
  /** Admissions still running when the drain stopped. The next process replays them from the inbox. */
  unsettled: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeObject(value) && !Array.isArray(value)
}

/** Resolves the `ackTimeoutMs` of a webhook registration. `undefined` means the route waits for admission. */
export function resolveWebhookAckTimeoutMs(value: number | false | undefined): number | undefined {
  if (value === false) return
  if (value === undefined) return defaultWebhookAckTimeoutMs
  if (!Number.isFinite(value) || value < 0) {
    throw agentDiagnostics.AGENT_R0776({ message: "[vitehub] Webhook ackTimeoutMs must be a non-negative finite number or false." })
  }
  return value
}

/** The provider's delivery ID header, if the request has one. */
export function webhookDeliveryHeader(request: Request): string | undefined {
  return request.headers.get("x-github-delivery")
    || request.headers.get("x-gitlab-event-uuid")
    || request.headers.get("x-forgejo-delivery")
    || request.headers.get("x-gitea-delivery")
    || request.headers.get("x-vitehub-delivery-id")
    || request.headers.get("idempotency-key")
    || undefined
}

/** The delivery ID header, else the SHA-256 of the raw body, so a resent request uses the same inbox row. */
export async function webhookInboxId(request: Request, rawBody: Uint8Array): Promise<string> {
  const header = webhookDeliveryHeader(request)
  if (header) return header
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(rawBody))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function webhookInboxIndexKey(prefix: string): string {
  return `${prefix}inbox`
}

function webhookInboxKey(prefix: string, id: string): string {
  return `${prefix}inbox:${encodeURIComponent(id)}`
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

function logWebhookInbox(event: string, fields: Record<string, unknown>): void {
  const log = event.endsWith(".failed") || event.endsWith(".dropped") ? console.error : console.info
  log(JSON.stringify({ scope: "vitehub.channel.delivery", event, ...fields }))
}

function isStoredWebhookInboxEntry(value: unknown): value is StoredWebhookInboxEntry {
  return isRecord(value)
    && isRuntimeString(value.id)
    && isRuntimeString(value.receivedAt)
    && isRuntimeString(value.webhookId)
    && isRuntimeNumber(value.attempts)
    && isRecord(value.request)
    && isRuntimeString(value.request.url)
    && isRuntimeString(value.request.method)
    && isRuntimeString(value.request.body)
    && isRecord(value.request.headers)
}

/**
 * Stores a verified request before the route resolves its trigger. Once this write lands, the route
 * can answer the provider. The row stays until admission settles, so the next process can replay it.
 */
export async function openWebhookInbox(webhookState: WebhookInboxState, entry: WebhookInboxEntry): Promise<WebhookInbox> {
  const { keyPrefix, state } = webhookState
  const key = webhookInboxKey(keyPrefix, entry.id)
  const lock = await state.acquireLock(`${key}:admission`, webhookInboxRetentionMs)
  if (!lock) {
    return { attempts: 0, duplicate: true, id: entry.id, settle: async () => {}, release: async () => {} }
  }
  try {
    const previous = await state.get(key)
    const attempts = (isStoredWebhookInboxEntry(previous) ? previous.attempts : 0) + 1
    await state.set(key, { ...entry, attempts } satisfies StoredWebhookInboxEntry, webhookInboxRetentionMs)
    if (!previous) {
      await state.appendToList(webhookInboxIndexKey(keyPrefix), { id: entry.id, receivedAt: entry.receivedAt }, {
        ttlMs: webhookInboxRetentionMs,
      })
    }
    return {
      attempts,
      id: entry.id,
      async release() {
        await state.releaseLock(lock).catch(() => undefined)
      },
      async settle() {
        try {
          await state.delete(key)
        }
        catch (error) {
          logWebhookInbox("inbox.settle.failed", { deliveryScope: keyPrefix, error: errorMessage(error), inboxId: entry.id })
        }
        await state.releaseLock(lock).catch(() => undefined)
      },
    }
  }
  catch (error) {
    await state.releaseLock(lock).catch(() => undefined)
    throw error
  }
}

/**
 * Answers with the admission's own response when it settles before `deadline`. Otherwise answers
 * `202 { accepted: true, deferred: true, ok: true }` and lets admission finish in the background.
 * A deferred admission that throws or answers 5xx keeps its row, because a provider that got 202
 * does not send the request again.
 */
export async function acknowledgeWebhookAdmission(
  admission: Promise<Response>,
  inbox: WebhookInbox,
  deadline: number,
  fields: WebhookInboxLogFields,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<Response> {
  const deferred = Symbol("deferred")
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    admission.then(response => ({ response }), (error: unknown) => ({ error })),
    new Promise<typeof deferred>((resolve) => {
      timer = setTimeout(() => resolve(deferred), Math.max(0, deadline - Date.now()))
    }),
  ])
  clearTimeout(timer)
  if (outcome !== deferred) {
    if ("error" in outcome) {
      await inbox.release()
      throw outcome.error
    }
    if (outcome.response.status >= 500) await inbox.release()
    else await inbox.settle()
    return outcome.response
  }

  const deferredAt = Date.now()
  logWebhookInbox("admission.deferred", { ...fields, attempt: inbox.attempts, inboxId: inbox.id })
  const background = admission.then(
    async (response) => {
      // Reading the body settles a handled delivery the same way the provider's read would.
      await response.arrayBuffer().catch(() => undefined)
      const failed = response.status >= 500
      logWebhookInbox(failed ? "admission.failed" : "admission.completed", {
        ...fields,
        deferredMs: Date.now() - deferredAt,
        inboxId: inbox.id,
        status: response.status,
      })
      if (!failed) await inbox.settle()
      else await inbox.release()
    },
    (error: unknown) => {
      logWebhookInbox("admission.failed", { ...fields, deferredMs: Date.now() - deferredAt, error: errorMessage(error), inboxId: inbox.id })
      return inbox.release()
    },
  )
  deferredWebhookAdmissions.add(background)
  void background.finally(() => deferredWebhookAdmissions.delete(background))
  waitUntil?.(background)
  return Response.json({ accepted: true, deferred: true, ok: true }, { headers: { "cache-control": "no-store" }, status: 202 })
}

/**
 * Waits up to `timeoutMs` for webhook admissions that outlived their `ackTimeoutMs` answer.
 * The webhook queue stop calls it with `VITEHUB_SHUTDOWN_DRAIN_MS`. An admission that is still
 * running keeps its inbox row, and the next process replays it.
 */
export async function drainDeferredWebhookAdmissions(options: DrainDeferredWebhookAdmissionsOptions = {}): Promise<DrainDeferredWebhookAdmissionsResult> {
  const pending = [...deferredWebhookAdmissions]
  if (!pending.length) return { pending: 0, unsettled: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, options.timeoutMs ?? 0))
    }),
  ])
  clearTimeout(timer)
  return { pending: pending.length, unsettled: pending.filter(admission => deferredWebhookAdmissions.has(admission)).length }
}

/**
 * Sends each stored request that arrived before `before` through the webhook route again.
 * The route checks the signature again and counts the attempt. A request that reached the
 * attempt limit is dropped.
 */
export async function replayWebhookInbox(
  scopes: Iterable<WebhookInboxState>,
  before: number,
  route: (request: Request, webhookId: string) => Promise<Response>,
): Promise<void> {
  const states = new Map<string, StateAdapter>()
  for (const { keyPrefix, state } of scopes) states.set(keyPrefix, state)
  for (const [keyPrefix, state] of states) {
    const seen = new Set<string>()
    for (const indexed of await state.getList(webhookInboxIndexKey(keyPrefix))) {
      if (!isRecord(indexed) || !isRuntimeString(indexed.id) || seen.has(indexed.id)) continue
      seen.add(indexed.id)
      const key = webhookInboxKey(keyPrefix, indexed.id)
      const stored = await state.get(key)
      if (!isStoredWebhookInboxEntry(stored) || !(Date.parse(stored.receivedAt) < before)) continue
      const fields = { attempts: stored.attempts, deliveryScope: keyPrefix, inboxId: stored.id }
      if (stored.attempts >= webhookInboxMaxAttempts) {
        logWebhookInbox("inbox.dropped", fields)
        await state.delete(key)
        continue
      }
      logWebhookInbox("inbox.replaying", { ...fields, receivedAt: stored.receivedAt })
      try {
        // A previous process may have crashed while holding the admission lock. Startup replay
        // owns recovery, so take over that lock before sending the request through the route.
        await state.forceReleaseLock(`${key}:admission`)
        const response = await route(new Request(stored.request.url, {
          body: stored.request.body || undefined,
          headers: stored.request.headers,
          method: stored.request.method,
        }), stored.webhookId)
        await response.arrayBuffer().catch(() => undefined)
        logWebhookInbox("inbox.replayed", { ...fields, status: response.status })
      }
      catch (error) {
        logWebhookInbox("inbox.replay.failed", { ...fields, error: errorMessage(error) })
      }
    }
  }
}
