import type { StateAdapter } from "chat"

import { isRuntimeBigInt, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "./runtime-value.ts"

import type {
  AgentChannelDelivery,
  AgentChannelDeliveryEvent,
  AgentChannelDeliveryEventInput,
  AgentChannelDeliveryInspection,
  AgentChannelDeliveryStatus,
  AgentRuntimeContext,
} from "../types.ts"

const retentionMs = 30 * 24 * 60 * 60 * 1000
const maximumEvents = 256
const maximumDeliveries = 10_000
const indexKey = "deliveries:index"
const activeDeliveries = new Map<string, AgentChannelDeliveryTracker>()
let workflowResolver: AgentChannelDeliveryWorkflowResolver | undefined
let workflowOwnershipResolver: AgentChannelDeliveryWorkflowOwnershipResolver | undefined

interface StoredAgentChannelDelivery extends AgentChannelDelivery {
  journalRetrySignaled?: boolean
  journalStatus?: AgentChannelDeliveryStatus
}

export const agentChannelDeliveryTrackerKey: symbol = Symbol.for("vitehub.agent.channel-delivery")
export const agentChannelDeliveryOwnershipVerifierKey: symbol = Symbol.for("vitehub.agent.channel-delivery-ownership-verifier")
export const agentChannelDeliveryWorkflowContextKey = "vitehub.channelDelivery"

export function isAgentChannelDeliveryWorkflowBinding(value: unknown): value is AgentChannelDeliveryWorkflowBinding {
  return Boolean(
    value &&
    isRuntimeObject(value) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    (isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).channelId) || (value as AgentChannelDeliveryWorkflowBinding).channelId === undefined) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).deliveryId) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).provider) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    ((value as AgentChannelDeliveryWorkflowBinding).state === "chat" || (value as AgentChannelDeliveryWorkflowBinding).state === "webhook"),
  )
}

export interface AgentChannelDeliveryWorkflowBinding {
  channelId?: string
  deliveryId: string
  provider: string
  state: "chat" | "webhook"
  steer?: {
    claimId: string
    deliveryIds?: string[]
    lock: { expiresAt: number; threadId: string; token: string }
    queue: string
    pendingQueue: string
    ttlMs: number
  }
}

export interface AgentChannelDeliveryTracker {
  claimed: boolean
  delivery: AgentChannelDelivery
  duplicate: boolean
  event(input: AgentChannelDeliveryEventInput): Promise<AgentChannelDeliveryEvent>
}

type AgentChannelDeliveryWorkflowResolver = (
  agent: unknown,
  context: AgentRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
) => Promise<AgentChannelDeliveryTracker | undefined>

type AgentChannelDeliveryWorkflowOwnershipResolver = (
  agent: unknown,
  context: AgentRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
) => Promise<AgentChannelDeliveryWorkflowOwnership | undefined>

export interface AgentChannelDeliveryWorkflowOwnership {
  abortSignal?: AbortSignal
  checkpoint?(status: "completed" | "failed"): Promise<void>
  handedOff?: boolean
  retrySettlementFailures?: boolean
  settlementStatus?: "completed" | "failed"
  verify?(): Promise<void>
  settle(status: "completed" | "failed"): Promise<void>
}

function deliveryRecordKey(deliveryId: string): string {
  return `deliveries:${deliveryId}`
}

function deliveryEventsKey(deliveryId: string): string {
  return `deliveries:${deliveryId}:events`
}

function messageKey(provider: string, threadId: string, messageId: string): string {
  return `deliveries:message:${encodeURIComponent(`${provider}:${threadId}:${messageId}`)}`
}

function payloadKey(provider: string, fingerprint: string): string {
  return `deliveries:payload:${encodeURIComponent(`${provider}:${fingerprint}`)}`
}

function sourceKey(delivery: Pick<AgentChannelDelivery, "channelId" | "provider" | "scope" | "sourceId">): string {
  return `deliveries:source:${encodeURIComponent(`${delivery.provider}:${delivery.channelId || ""}:${delivery.scope}:${delivery.sourceId}`)}`
}

function token(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function agentChannelDeliverySourceValue(value: unknown): string | undefined {
  return isRuntimeString(value) && value ? value : isRuntimeNumber(value) || isRuntimeBigInt(value) ? String(value) : undefined
}

export function agentChannelDeliverySourceId(provider: string, payload: unknown): string | undefined {
  if (!payload || !isRuntimeObject(payload) || Array.isArray(payload)) return
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const record = payload as Record<string, unknown>
  const activity =
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    record.activity && isRuntimeObject(record.activity) && !Array.isArray(record.activity) ? (record.activity as Record<string, unknown>) : undefined
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const event = record.event && isRuntimeObject(record.event) && !Array.isArray(record.event) ? (record.event as Record<string, unknown>) : undefined
  return (
    agentChannelDeliverySourceValue(record.event_id) ||
    agentChannelDeliverySourceValue(record.update_id) ||
    (provider === "teams" || provider === "discord" ? agentChannelDeliverySourceValue(record.id) : undefined) ||
    agentChannelDeliverySourceValue(activity?.id) ||
    agentChannelDeliverySourceValue(event?.id)
  )
}

export function agentChannelDeliveryMessageIdentity(provider: string, payload: unknown): { messageId: string; threadId: string } | undefined {
  if (!payload || !isRuntimeObject(payload) || Array.isArray(payload)) return
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const record = payload as Record<string, unknown>
  if (provider === "telegram") {
    const message =
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      record.message && isRuntimeObject(record.message) && !Array.isArray(record.message) ? (record.message as Record<string, unknown>) : undefined
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    const chat = message?.chat && isRuntimeObject(message.chat) && !Array.isArray(message.chat) ? (message.chat as Record<string, unknown>) : undefined
    const messageId = agentChannelDeliverySourceValue(message?.message_id)
    const chatId = agentChannelDeliverySourceValue(chat?.id)
    if (messageId && chatId) return { messageId, threadId: `telegram:${chatId}` }
  }
}

function stablePayload(value: unknown): string {
  if (!value || !isRuntimeObject(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stablePayload(entry)}`)
    .join(",")}}`
}

export async function agentChannelDeliveryPayloadFingerprint(payload: unknown): Promise<string | undefined> {
  if (payload === undefined) return
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stablePayload(payload)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function log(event: AgentChannelDeliveryEvent, delivery: AgentChannelDelivery): void {
  console.info(
    JSON.stringify({
      scope: "vitehub.channel.delivery",
      agentName: delivery.agentName,
      channelId: delivery.channelId,
      deliveryScope: delivery.scope,
      provider: delivery.provider,
      sourceId: delivery.sourceId,
      ...event,
    }),
  )
}

async function touchDeliveryIndex(state: StateAdapter, deliveryId: string): Promise<void> {
  await state.appendToList(indexKey, deliveryId, {
    maxLength: maximumDeliveries,
    ttlMs: retentionMs,
  })
}

function advanceDeliveryStatus(
  current: AgentChannelDeliveryStatus,
  retrySignaled: boolean,
  event: Pick<AgentChannelDeliveryEvent, "type">,
): { retrySignaled: boolean; status: AgentChannelDeliveryStatus } {
  if (event.type === "duplicate") return { retrySignaled: true, status: current }
  if (current === "completed" || current === "failed" || current === "rejected") {
    const retryStarts =
      event.type === "retrying" ||
      (retrySignaled && event.type === "accepted") ||
      (event.type === "invocation.started" && (retrySignaled || current === "failed"))
    if (!retryStarts) return { retrySignaled, status: current }
    retrySignaled = false
  }
  if (event.type === "invocation.started") return { retrySignaled, status: "running" }
  if (event.type === "received") return { retrySignaled, status: "received" }
  if (
    event.type === "accepted" ||
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "queued" ||
    event.type === "rejected" ||
    event.type === "retrying"
  ) {
    return { retrySignaled, status: event.type }
  }
  return { retrySignaled, status: current }
}

function publicDelivery(delivery: StoredAgentChannelDelivery): AgentChannelDelivery {
  const { journalRetrySignaled: _journalRetrySignaled, journalStatus: _journalStatus, ...value } = delivery
  return value
}

function reduceDeliveryStatus(
  events: AgentChannelDeliveryEvent[],
  initial: { retrySignaled: boolean; status: AgentChannelDeliveryStatus } = {
    retrySignaled: false,
    status: "received",
  },
): { retrySignaled: boolean; status: AgentChannelDeliveryStatus } {
  return events.reduce<{ retrySignaled: boolean; status: AgentChannelDeliveryStatus }>(
    (current, event) => advanceDeliveryStatus(current.status, current.retrySignaled, event),
    initial,
  )
}

async function acquireDeliveryLock(state: StateAdapter, deliveryId: string) {
  const lockKey = `deliveries:${deliveryId}:journal-lock`
  for (let attempt = 0; attempt < 500; attempt++) {
    const lock = await state.acquireLock(lockKey, 30_000)
    if (lock) return lock
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for the Agent Channel delivery journal lock.")
}

async function appendEvent(
  state: StateAdapter,
  delivery: StoredAgentChannelDelivery,
  input: AgentChannelDeliveryEventInput,
): Promise<AgentChannelDeliveryEvent> {
  const terminal = input.type === "completed" || input.type === "failed" || input.type === "rejected"
  let event: AgentChannelDeliveryEvent = {
    ...input,
    ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
    at: new Date().toISOString(),
    deliveryId: delivery.id,
    id: token(),
  }
  try {
    const lock = await acquireDeliveryLock(state, delivery.id)
    let ownershipLost = false
    const renewal = setInterval(() => {
      void state
        .extendLock(lock, 30_000)
        .then((extended) => {
          if (!extended) ownershipLost = true
        })
        .catch(() => {
          ownershipLost = true
        })
    }, 10_000)
    const renew = async () => {
      if (ownershipLost || !(await state.extendLock(lock, 30_000))) {
        ownershipLost = true
        throw new Error("Lost ownership of the Agent Channel delivery journal lock.")
      }
    }
    try {
      await renew()
      const current = (await state.get<StoredAgentChannelDelivery>(deliveryRecordKey(delivery.id))) || delivery
      const events = await state.getList<AgentChannelDeliveryEvent>(deliveryEventsKey(delivery.id))
      const reduced = reduceDeliveryStatus(
        events,
        current.journalStatus ? { retrySignaled: current.journalRetrySignaled || false, status: current.journalStatus } : undefined,
      )
      const persistedTerminal =
        terminal && !reduced.retrySignaled && reduced.status === input.type ? events.findLast((entry) => entry.type === input.type) : undefined
      if (persistedTerminal) event = persistedTerminal
      const next = advanceDeliveryStatus(reduced.status, reduced.retrySignaled, event)
      const stored = {
        ...current,
        journalRetrySignaled: next.retrySignaled,
        journalStatus: next.status,
      }
      await renew()
      if (!persistedTerminal) {
        await state.appendToList(deliveryEventsKey(delivery.id), event, {
          maxLength: maximumEvents,
          ttlMs: retentionMs,
        })
      }
      await renew()
      await state.set(sourceKey(stored), stored, retentionMs)
      await renew()
      await state.set(deliveryRecordKey(stored.id), stored, retentionMs)
      await renew()
      if (event.type === "received" || event.type === "duplicate") await touchDeliveryIndex(state, delivery.id)
    } finally {
      clearInterval(renewal)
      try {
        await state.releaseLock(lock)
      } catch (error) {
        console.error(
          JSON.stringify({
            scope: "vitehub.channel.delivery",
            event: "journal.lock-release.failed",
            deliveryId: delivery.id,
            provider: delivery.provider,
            sourceId: delivery.sourceId,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          }),
        )
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "vitehub.channel.delivery",
        event: "journal.failed",
        attemptedEvent: event.type,
        attemptedError: event.error,
        deliveryId: delivery.id,
        provider: delivery.provider,
        sourceId: delivery.sourceId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      }),
    )
    throw error
  } finally {
    if (terminal) activeDeliveries.delete(delivery.id)
  }
  log(event, delivery)
  return event
}

function tracker(state: StateAdapter, stored: StoredAgentChannelDelivery, duplicate: boolean): AgentChannelDeliveryTracker {
  const delivery = publicDelivery(stored)
  const value: AgentChannelDeliveryTracker = {
    claimed: false,
    delivery,
    duplicate,
    event: async (input) => await appendEvent(state, stored, input),
  }
  // A duplicate may already be terminal and is still usable through its request
  // context. Keeping it process-global would retain its State Adapter forever.
  if (!duplicate) activeDeliveries.set(delivery.id, value)
  return value
}

export function activeAgentChannelDelivery(deliveryId: string): AgentChannelDeliveryTracker | undefined {
  return activeDeliveries.get(deliveryId)
}

export function detachAgentChannelDelivery(delivery: AgentChannelDeliveryTracker): void {
  if (activeDeliveries.get(delivery.delivery.id) === delivery) activeDeliveries.delete(delivery.delivery.id)
}

export function setAgentChannelDeliveryWorkflowResolver(resolver: AgentChannelDeliveryWorkflowResolver): void {
  workflowResolver = resolver
}

export function setAgentChannelDeliveryWorkflowOwnershipResolver(resolver: AgentChannelDeliveryWorkflowOwnershipResolver): void {
  workflowOwnershipResolver = resolver
}

export async function resumeAgentChannelDeliveryWorkflowOwnership(
  agent: unknown,
  context: AgentRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
): Promise<AgentChannelDeliveryWorkflowOwnership | undefined> {
  return await workflowOwnershipResolver?.(agent, context, binding)
}

export async function resumeWorkflowAgentChannelDelivery(
  agent: unknown,
  context: AgentRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
): Promise<AgentChannelDeliveryTracker | undefined> {
  return activeAgentChannelDelivery(binding.deliveryId) || (await workflowResolver?.(agent, context, binding))
}

export async function openAgentChannelDelivery(
  state: StateAdapter,
  input: Omit<AgentChannelDelivery, "id" | "receivedAt">,
): Promise<AgentChannelDeliveryTracker> {
  const candidate: StoredAgentChannelDelivery = {
    ...input,
    id: token(),
    receivedAt: new Date().toISOString(),
  }
  const created = await state.setIfNotExists(sourceKey(candidate), candidate, retentionMs)
  const delivery = created ? candidate : (await state.get<StoredAgentChannelDelivery>(sourceKey(candidate))) || candidate
  await state.set(sourceKey(delivery), delivery, retentionMs)
  await state.set(deliveryRecordKey(delivery.id), delivery, retentionMs)
  const opened = tracker(state, delivery, !created)
  try {
    await opened.event({ type: opened.duplicate ? "duplicate" : "received" })
  } catch (error) {
    detachAgentChannelDelivery(opened)
    throw error
  }
  return opened
}

export async function resumeAgentChannelDelivery(state: StateAdapter, deliveryId: string): Promise<AgentChannelDeliveryTracker | undefined> {
  const stored = await state.get<StoredAgentChannelDelivery>(deliveryRecordKey(deliveryId))
  return stored ? tracker(state, stored, false) : undefined
}

export async function bindAgentChannelDeliveryMessage(
  state: StateAdapter,
  delivery: AgentChannelDeliveryTracker,
  provider: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  await state.set(messageKey(provider, threadId, messageId), delivery.delivery.id, retentionMs)
}

export async function resumeAgentChannelDeliveryMessage(
  state: StateAdapter,
  provider: string,
  threadId: string,
  messageId: string,
): Promise<AgentChannelDeliveryTracker | undefined> {
  const deliveryId = await state.get<string>(messageKey(provider, threadId, messageId))
  return deliveryId ? await resumeAgentChannelDelivery(state, deliveryId) : undefined
}

export async function bindAgentChannelDeliveryPayload(
  state: StateAdapter,
  delivery: AgentChannelDeliveryTracker,
  provider: string,
  fingerprint: string,
): Promise<void> {
  await state.set(payloadKey(provider, fingerprint), delivery.delivery.id, retentionMs)
}

export async function resumeAgentChannelDeliveryPayload(
  state: StateAdapter,
  provider: string,
  fingerprint: string,
): Promise<AgentChannelDeliveryTracker | undefined> {
  const deliveryId = await state.get<string>(payloadKey(provider, fingerprint))
  return deliveryId ? await resumeAgentChannelDelivery(state, deliveryId) : undefined
}

export function agentChannelDeliveryTracker(context: AgentRuntimeContext): AgentChannelDeliveryTracker | undefined {
  const runtimeContext: unknown = context
  // SAFETY: withAgentChannelDelivery installs this private tracker property on Agent runtime contexts.
  return (runtimeContext as AgentRuntimeContext & { [agentChannelDeliveryTrackerKey]?: AgentChannelDeliveryTracker })[agentChannelDeliveryTrackerKey]
}

export function agentChannelDeliveryOwnershipVerifier(context: AgentRuntimeContext): (() => Promise<void>) | undefined {
  const runtimeContext: unknown = context
  // SAFETY: withAgentChannelDeliveryOwnershipVerifier installs this private verifier property on Agent runtime contexts.
  return (runtimeContext as AgentRuntimeContext & { [agentChannelDeliveryOwnershipVerifierKey]?: () => Promise<void> })[
    agentChannelDeliveryOwnershipVerifierKey
  ]
}

export function withAgentChannelDeliveryOwnershipVerifier<T extends AgentRuntimeContext>(context: T, verify: () => Promise<void>): T {
  return { ...context, [agentChannelDeliveryOwnershipVerifierKey]: verify }
}

export function withAgentChannelDelivery<T extends AgentRuntimeContext>(context: T, deliveryTracker: AgentChannelDeliveryTracker): T {
  return {
    ...context,
    channelDelivery: deliveryTracker.delivery,
    [agentChannelDeliveryTrackerKey]: deliveryTracker,
  }
}

export async function readAgentChannelDeliveries(
  state: Pick<StateAdapter, "get" | "getList">,
  limit = 100,
  scopePrefix?: string,
): Promise<AgentChannelDeliveryInspection[]> {
  const ids = await state.getList<string>(indexKey)
  const stored: Array<
    AgentChannelDelivery & {
      events: AgentChannelDeliveryEvent[]
      persistedRetrySignaled?: boolean
      persistedStatus?: AgentChannelDeliveryStatus
    }
  > = []
  const seen = new Set<string>()
  const maximum = Math.max(0, limit)
  for (const id of [...ids].reverse()) {
    if (stored.length >= maximum) break
    if (seen.has(id)) continue
    seen.add(id)
    const delivery = await state.get<StoredAgentChannelDelivery>(deliveryRecordKey(id))
    if (!delivery || (scopePrefix && !delivery.scope.startsWith(scopePrefix))) continue
    stored.push({
      ...publicDelivery(delivery),
      events: await state.getList<AgentChannelDeliveryEvent>(deliveryEventsKey(id)),
      persistedRetrySignaled: delivery.journalRetrySignaled,
      persistedStatus: delivery.journalStatus,
    })
  }
  return stored.map((delivery) => {
    const { persistedRetrySignaled, persistedStatus, ...inspection } = delivery
    return {
      ...inspection,
      status: reduceDeliveryStatus(delivery.events, persistedStatus ? { retrySignaled: persistedRetrySignaled || false, status: persistedStatus } : undefined)
        .status,
    }
  })
}
