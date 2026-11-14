import type { StateAdapter } from "chat"

import { agentDiagnostics } from "../agent-diagnostics.ts"

/** A webhook gets an answer within this many milliseconds of its arrival, once its request is stored. */
export const defaultWebhookAckTimeoutMs = 5_000
/** A stored request that no process admitted is kept for one day. */
const webhookInboxRetentionMs = 86_400_000
/** The route admits a stored request at most this many times, the first delivery included. */
const webhookInboxMaxAttempts = 3
const webhookInboxOwnerTtlMs = 30_000
/**
 * Width of one replay index list. A list expires a day after its last append, so closing a list
 * every hour bounds the index to the retention window plus one hour of webhooks.
 */
const webhookInboxIndexBucketMs = 3_600_000
/** Rows of the legacy replay list read at once. Each row carries a whole request. */
const webhookInboxLegacyPageSize = 100
/** How long a duplicate delivery waits for the first one to store its request. */
const webhookInboxDuplicateWaitMs = 2_000

/** Admissions that got a 202 answer and still run. `drainDeferredWebhookAdmissions()` waits for them. */
const deferredWebhookAdmissions = new Set<Promise<void>>()
// Locks held by this process must never be taken over by startup replay.
const activeWebhookInboxLocks = new Set<string>()

/** State that can read a list a page at a time. `cursor` of the last value continues the next page. */
interface PagedListStateAdapter {
  getListPage(key: string, after: number, limit: number): Promise<Array<{ cursor: number, value: unknown }>>
}

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
  /** Highest admission count already recorded by replay metadata. */
  priorAttempts?: number
}

interface StoredWebhookInboxEntry extends WebhookInboxEntry {
  attempts: number
}

/** A replay index entry. The stored row keeps the request. */
interface WebhookInboxIndexEntry {
  attempts: number
  id: string
}

export interface WebhookInbox {
  attempts: number
  id: string
  /** Another request currently owns admission for this delivery. */
  duplicate?: boolean
  /**
   * For a duplicate, whether the first request's copy is stored, so a restart can replay it.
   * Only then may the route answer the duplicate with a 2xx.
   */
  stored?: boolean
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

/** Before replay indexed by hour, one list per scope held complete copies of every request. */
function legacyWebhookInboxIndexKey(prefix: string): string {
  return `${prefix}inbox`
}

function webhookInboxIndexKey(prefix: string, bucket: number): string {
  return `${prefix}inbox-index:${bucket}`
}

function webhookInboxIndexBucket(time: number): number {
  return Math.floor(time / webhookInboxIndexBucketMs)
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
    && typeof value.id === "string"
    && typeof value.receivedAt === "string"
    && typeof value.webhookId === "string"
    && typeof value.attempts === "number"
    && isRecord(value.request)
    && typeof value.request.url === "string"
    && typeof value.request.method === "string"
    && typeof value.request.body === "string"
    && isRecord(value.request.headers)
}

/** Whether the request at `key` is stored or was settled, polling until `deadline`. */
async function waitForStoredWebhookInbox(state: StateAdapter, key: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (isStoredWebhookInboxEntry(await state.get(key))) return true
    const owner = await state.get(`${key}:owner`)
    if (isRecord(owner) && owner.settled === true) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Stores a verified request before the route resolves its trigger. Once this write lands, the route
 * can answer the provider. The row stays until admission settles, so the next process can replay it.
 */
export async function openWebhookInbox(
  webhookState: WebhookInboxState,
  entry: WebhookInboxEntry,
  /** Until when a duplicate waits for the first request to be stored. Defaults to 2 seconds from now. */
  duplicateDeadline: number = Date.now() + webhookInboxDuplicateWaitMs,
): Promise<WebhookInbox> {
  const { keyPrefix, state } = webhookState
  const key = webhookInboxKey(keyPrefix, entry.id)
  const lock = await state.acquireLock(`${key}:admission`, webhookInboxRetentionMs)
  if (!lock) {
    const stored = await waitForStoredWebhookInbox(state, key, duplicateDeadline)
    return { attempts: 0, duplicate: true, id: entry.id, stored, settle: async () => {}, release: async () => {} }
  }
  activeWebhookInboxLocks.add(key)
  const ownerKey = `${key}:owner`
  const ownerToken = crypto.randomUUID()
  try {
    await state.set(ownerKey, { token: ownerToken, heartbeatAt: Date.now() }, webhookInboxOwnerTtlMs)
  }
  catch (error) {
    activeWebhookInboxLocks.delete(key)
    await state.releaseLock(lock).catch(() => undefined)
    throw error
  }
  const ownerHeartbeat = setInterval(() => {
    void state.set(ownerKey, { token: ownerToken, heartbeatAt: Date.now() }, webhookInboxOwnerTtlMs).catch(() => undefined)
  }, Math.max(1_000, webhookInboxOwnerTtlMs / 3))
  try {
    const previous = await state.get(key)
    const previousAttempts = isStoredWebhookInboxEntry(previous) ? previous.attempts : 0
    const attempts = Math.max(previousAttempts, entry.priorAttempts ?? 0) + 1
    // Index before the row, so every stored row has an index entry whose list lives as long
    // as the row. Each admission indexes again, because it renews the row's retention.
    // The route answers the provider only after both writes, so a process that stops between
    // them leaves a request the provider saw fail, the same as one that stops before either.
    await state.appendToList(
      webhookInboxIndexKey(keyPrefix, webhookInboxIndexBucket(Date.now())),
      { attempts, id: entry.id } satisfies WebhookInboxIndexEntry,
      { ttlMs: webhookInboxRetentionMs },
    )
    await state.set(key, { ...entry, attempts } satisfies StoredWebhookInboxEntry, webhookInboxRetentionMs)
    return {
      attempts,
      id: entry.id,
      async release() {
        clearInterval(ownerHeartbeat)
        // Release the durable lock before removing the owner lease. Replay uses
        // the lease as its crashed-owner signal; keeping it visible until the
        // lock is gone prevents takeover during settlement.
        await state.releaseLock(lock).catch(() => undefined)
        activeWebhookInboxLocks.delete(key)
        const currentOwner = await state.get(ownerKey).catch(() => undefined)
        if (isRecord(currentOwner) && currentOwner.token === ownerToken) await state.delete(ownerKey).catch(() => undefined)
      },
      async settle() {
        clearInterval(ownerHeartbeat)
        try {
          await state.delete(key)
        }
        catch (error) {
          logWebhookInbox("inbox.settle.failed", { deliveryScope: keyPrefix, error: errorMessage(error), inboxId: entry.id })
        }
        // Keep a settled marker while the replay index entries expire. It is written
        // before releasing the lock, so replay can never mistake this settlement for
        // a crashed owner and remove a replacement owner's marker.
        await state.set(ownerKey, { settled: true }, webhookInboxRetentionMs).catch(() => undefined)
        await state.releaseLock(lock).catch(() => undefined)
        activeWebhookInboxLocks.delete(key)
      },
    }
  }
  catch (error) {
    clearInterval(ownerHeartbeat)
    activeWebhookInboxLocks.delete(key)
    await state.delete(ownerKey).catch(() => undefined)
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
 * The route checks the signature again, with timestamps measured from the request's first
 * arrival, and counts the attempt. A request that reached the attempt limit is dropped.
 */
export async function replayWebhookInbox(
  scopes: Iterable<WebhookInboxState>,
  before: number,
  route: (request: Request, webhookId: string, priorAttempts: number, receivedAt: number) => Promise<Response>,
): Promise<void> {
  const states = new Map<string, StateAdapter>()
  for (const { keyPrefix, state } of scopes) states.set(keyPrefix, state)
  for (const [keyPrefix, state] of states) {
    const indexedAttempts = new Map<string, number>()
    // An index list can hold entries until a day after its last append. A process whose clock
    // runs ahead of this one can have indexed into the next hour.
    const lastBucket = webhookInboxIndexBucket(Date.now()) + 1
    for (let bucket = webhookInboxIndexBucket(Date.now() - webhookInboxRetentionMs) - 1; bucket <= lastBucket; bucket++) {
      for (const indexed of await state.getList(webhookInboxIndexKey(keyPrefix, bucket))) {
        if (!isRecord(indexed) || typeof indexed.id !== "string") continue
        indexedAttempts.set(indexed.id, Math.max(indexedAttempts.get(indexed.id) ?? 0, typeof indexed.attempts === "number" ? indexed.attempts : 0))
      }
    }
    await migrateLegacyWebhookInbox(keyPrefix, state, indexedAttempts)
    for (const [id, indexed] of indexedAttempts) {
      const key = webhookInboxKey(keyPrefix, id)
      const stored = await state.get(key)
      if (!isStoredWebhookInboxEntry(stored)) continue
      const attempts = Math.max(stored.attempts, indexed)
      const fields = { attempts, deliveryScope: keyPrefix, inboxId: stored.id }
      const owner = await state.get(`${key}:owner`)
      if (isRecord(owner) && owner.settled === true) continue
      if (attempts >= webhookInboxMaxAttempts) {
        logWebhookInbox("inbox.dropped", fields)
        await state.delete(key)
        continue
      }
      // A request newer than this process's recovery boundary still has an index entry for the next restart.
      if (!(Date.parse(stored.receivedAt) < before)) continue
      logWebhookInbox("inbox.replaying", { ...fields, receivedAt: stored.receivedAt })
      try {
        const makeRequest = () => new Request(stored.request.url, {
          body: stored.request.body || undefined,
          headers: stored.request.headers,
          method: stored.request.method,
        })
        let response = await route(makeRequest(), stored.webhookId, attempts, Date.parse(stored.receivedAt))
        // A lock left by a crashed process is indistinguishable from a duplicate request
        // at the route boundary. If this process does not own it, take over once and retry.
        const currentOwner = await state.get(`${key}:owner`)
        const ownerIsStale = isRecord(currentOwner)
          && typeof currentOwner.heartbeatAt === "number"
          && Date.now() - currentOwner.heartbeatAt > webhookInboxOwnerTtlMs / 3
        if (response.headers.get("x-vitehub-webhook-duplicate") === "1" && !activeWebhookInboxLocks.has(key) && (!(isRecord(currentOwner) && currentOwner.settled === true)) && (!currentOwner || ownerIsStale)) {
          const forceReleaseLock = (state as StateAdapter & { forceReleaseLock?: (threadId: string) => Promise<void> }).forceReleaseLock
          if (forceReleaseLock) {
            // Re-read the lease immediately before takeover. A replacement admission
            // must not be revoked by a replay that observed an older owner.
            const takeoverOwner = await state.get(`${key}:owner`)
            const sameOwner = !currentOwner
              ? !takeoverOwner
              : isRecord(currentOwner) && isRecord(takeoverOwner) && currentOwner.token === takeoverOwner.token
            if (sameOwner && !(isRecord(takeoverOwner) && takeoverOwner.settled === true)) {
              await forceReleaseLock(`${key}:admission`).catch(() => undefined)
              response = await route(makeRequest(), stored.webhookId, attempts, Date.parse(stored.receivedAt))
            }
          }
        }
        await response.arrayBuffer().catch(() => undefined)
        logWebhookInbox("inbox.replayed", { ...fields, status: response.status })
      }
      catch (error) {
        logWebhookInbox("inbox.replay.failed", { ...fields, error: errorMessage(error) })
      }
    }
  }
}

/**
 * Moves each request that the legacy list still needs replayed into the hourly index, writing its
 * row from the list's copy when the row is missing. The list is not deleted: a process of the
 * previous version may still append to it during a rolling deploy. It expires a day after its last
 * append. With `getListPage`, the list is read a page at a time from where the last migration
 * stopped, so its request bodies are never all in memory.
 */
async function migrateLegacyWebhookInbox(keyPrefix: string, state: StateAdapter, indexedAttempts: Map<string, number>): Promise<void> {
  const legacyKey = legacyWebhookInboxIndexKey(keyPrefix)
  const moved = new Set<string>()
  const migrate = async (legacy: unknown) => {
    if (!isRecord(legacy) || typeof legacy.id !== "string" || indexedAttempts.has(legacy.id) || moved.has(legacy.id)) return
    const key = webhookInboxKey(keyPrefix, legacy.id)
    const row = await state.get(key)
    const storedRow = isStoredWebhookInboxEntry(row) ? row : undefined
    // A copy without a row is replayable for as long as its row would have been kept.
    // An older one belongs to an admission whose settled marker has expired.
    const copy = !storedRow && isStoredWebhookInboxEntry(legacy) && Date.now() - Date.parse(legacy.receivedAt) < webhookInboxRetentionMs
      ? legacy
      : undefined
    if (!storedRow && !copy) return
    moved.add(legacy.id)
    const owner = await state.get(`${key}:owner`)
    if (isRecord(owner) && owner.settled === true) return
    const attempts = Math.max(storedRow?.attempts ?? 0, typeof legacy.attempts === "number" ? legacy.attempts : 0)
    await state.appendToList(
      webhookInboxIndexKey(keyPrefix, webhookInboxIndexBucket(Date.now())),
      { attempts, id: legacy.id } satisfies WebhookInboxIndexEntry,
      { ttlMs: webhookInboxRetentionMs },
    )
    if (copy) await state.set(key, { ...copy, attempts } satisfies StoredWebhookInboxEntry, webhookInboxRetentionMs)
    indexedAttempts.set(legacy.id, attempts)
  }
  const pages = state as StateAdapter & Partial<Pick<PagedListStateAdapter, "getListPage">>
  if (!pages.getListPage) {
    for (const legacy of await state.getList(legacyKey)) await migrate(legacy)
    return
  }
  const cursorKey = `${keyPrefix}inbox-index:legacy-cursor`
  const saved = await state.get(cursorKey)
  let after = isRecord(saved) && typeof saved.after === "number" ? saved.after : 0
  for (;;) {
    const page = await pages.getListPage(legacyKey, after, webhookInboxLegacyPageSize)
    if (!page.length) return
    for (const { cursor, value } of page) {
      await migrate(value)
      after = cursor
    }
    await state.set(cursorKey, { after }, webhookInboxRetentionMs)
  }
}
