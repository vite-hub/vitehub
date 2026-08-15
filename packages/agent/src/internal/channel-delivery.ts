import type { StateAdapter } from "chat"

import type { AgentChannelDelivery, AgentChannelDeliveryEvent, AgentChannelDeliveryEventInput, AgentChannelDeliveryInspection, AgentChannelDeliveryStatus, AgentRuntimeContext } from "../types.ts"

const retentionMs = 30 * 24 * 60 * 60 * 1000
const maximumEvents = 256
const maximumDeliveries = 10_000
const indexKey = "deliveries:index"
const indexLockKey = "deliveries:index:lock"
const activeDeliveries = new Map<string, AgentChannelDeliveryTracker>()
const indexUpdateTails = new WeakMap<StateAdapter, Promise<void>>()
let workflowResolver: AgentChannelDeliveryWorkflowResolver | undefined

export const agentChannelDeliveryTrackerKey: symbol = Symbol.for("vitehub.agent.channel-delivery")
export const agentChannelDeliveryWorkflowContextKey = "vitehub.channelDelivery"

export interface AgentChannelDeliveryWorkflowBinding {
  channelId?: string
  deliveryId: string
  provider: string
  state: "chat" | "webhook"
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

function sourceKey(delivery: Pick<AgentChannelDelivery, "provider" | "scope" | "sourceId">): string {
  return `deliveries:source:${encodeURIComponent(`${delivery.provider}:${delivery.scope}:${delivery.sourceId}`)}`
}

function token(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sourceValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : undefined
}

export function agentChannelDeliverySourceId(provider: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
  const record = payload as Record<string, unknown>
  const activity = record.activity && typeof record.activity === "object" && !Array.isArray(record.activity) ? record.activity as Record<string, unknown> : undefined
  const event = record.event && typeof record.event === "object" && !Array.isArray(record.event) ? record.event as Record<string, unknown> : undefined
  return sourceValue(record.event_id)
    || sourceValue(record.update_id)
    || (provider === "teams" || provider === "discord" ? sourceValue(record.id) : undefined)
    || sourceValue(activity?.id)
    || sourceValue(event?.id)
}

export function agentChannelDeliveryMessageIdentity(provider: string, payload: unknown): { messageId: string, threadId: string } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
  const record = payload as Record<string, unknown>
  if (provider === "telegram") {
    const message = record.message && typeof record.message === "object" && !Array.isArray(record.message) ? record.message as Record<string, unknown> : undefined
    const chat = message?.chat && typeof message.chat === "object" && !Array.isArray(message.chat) ? message.chat as Record<string, unknown> : undefined
    const messageId = sourceValue(message?.message_id)
    const chatId = sourceValue(chat?.id)
    if (messageId && chatId) return { messageId, threadId: `telegram:${chatId}` }
  }
}

function stablePayload(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stablePayload(entry)}`)
    .join(",")}}`
}

export async function agentChannelDeliveryPayloadFingerprint(payload: unknown): Promise<string | undefined> {
  if (payload === undefined) return
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stablePayload(payload)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
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

async function updateDeliveryIndex(state: StateAdapter, deliveryId: string): Promise<void> {
  const lockTtlMs = 5_000
  let lock = await state.acquireLock(indexLockKey, lockTtlMs)
  while (!lock) {
    await new Promise(resolve => setTimeout(resolve, 1))
    lock = await state.acquireLock(indexLockKey, lockTtlMs)
  }
  const indexLock = lock
  let extension = Promise.resolve(true)
  const heartbeat = setInterval(() => {
    extension = extension.then(async owned => owned && await state.extendLock(indexLock, lockTtlMs)).catch(() => false)
  }, 1_000)
  try {
    const ids = await state.get<string[]>(indexKey) || []
    if (!await state.extendLock(indexLock, lockTtlMs)) throw new Error("[vitehub] Agent Channel delivery index update lost its lock.")
    await state.set(indexKey, [...ids.filter(id => id !== deliveryId), deliveryId].slice(-maximumDeliveries), retentionMs)
  }
  finally {
    clearInterval(heartbeat)
    await extension
    await state.releaseLock(indexLock)
  }
}

async function touchDeliveryIndex(state: StateAdapter, deliveryId: string): Promise<void> {
  const previous = indexUpdateTails.get(state) || Promise.resolve()
  const update = previous.catch(() => undefined).then(async () => await updateDeliveryIndex(state, deliveryId))
  indexUpdateTails.set(state, update)
  try {
    await update
  }
  finally {
    if (indexUpdateTails.get(state) === update) indexUpdateTails.delete(state)
  }
}

async function appendEvent(state: StateAdapter, delivery: AgentChannelDelivery, input: AgentChannelDeliveryEventInput): Promise<AgentChannelDeliveryEvent> {
  const event: AgentChannelDeliveryEvent = {
    ...input,
    ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
    at: new Date().toISOString(),
    deliveryId: delivery.id,
    id: token(),
  }
  try {
    await state.set(sourceKey(delivery), delivery, retentionMs)
    await state.set(deliveryRecordKey(delivery.id), delivery, retentionMs)
    await state.appendToList(deliveryEventsKey(delivery.id), event, { maxLength: maximumEvents, ttlMs: retentionMs })
    await touchDeliveryIndex(state, delivery.id)
  }
  catch (error) {
    console.error(JSON.stringify({
      scope: "vitehub.channel.delivery",
      event: "journal.failed",
      attemptedEvent: event.type,
      attemptedError: event.error,
      deliveryId: delivery.id,
      provider: delivery.provider,
      sourceId: delivery.sourceId,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    }))
    throw error
  }
  log(event, delivery)
  if (event.type === "completed" || event.type === "failed" || event.type === "rejected") activeDeliveries.delete(delivery.id)
  return event
}

function tracker(state: StateAdapter, delivery: AgentChannelDelivery, duplicate: boolean): AgentChannelDeliveryTracker {
  const value: AgentChannelDeliveryTracker = {
    claimed: false,
    delivery,
    duplicate,
    event: async (input) => await appendEvent(state, delivery, input),
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

export async function resumeWorkflowAgentChannelDelivery(
  agent: unknown,
  context: AgentRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
): Promise<AgentChannelDeliveryTracker | undefined> {
  return activeAgentChannelDelivery(binding.deliveryId) || await workflowResolver?.(agent, context, binding)
}

export async function openAgentChannelDelivery(state: StateAdapter, input: Omit<AgentChannelDelivery, "id" | "receivedAt">): Promise<AgentChannelDeliveryTracker> {
  const candidate: AgentChannelDelivery = {
    ...input,
    id: token(),
    receivedAt: new Date().toISOString(),
  }
  const created = await state.setIfNotExists(sourceKey(candidate), candidate, retentionMs)
  const delivery = created ? candidate : (await state.get<AgentChannelDelivery>(sourceKey(candidate))) || candidate
  await state.set(sourceKey(delivery), delivery, retentionMs)
  await state.set(deliveryRecordKey(delivery.id), delivery, retentionMs)
  const opened = tracker(state, delivery, !created)
  try {
    await opened.event({ type: opened.duplicate ? "duplicate" : "received" })
  }
  catch (error) {
    detachAgentChannelDelivery(opened)
    throw error
  }
  return opened
}

export async function resumeAgentChannelDelivery(state: StateAdapter, deliveryId: string): Promise<AgentChannelDeliveryTracker | undefined> {
  const stored = await state.get<AgentChannelDelivery>(deliveryRecordKey(deliveryId))
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
  return (
    context as AgentRuntimeContext & {
      [agentChannelDeliveryTrackerKey]?: AgentChannelDeliveryTracker
    }
  )[agentChannelDeliveryTrackerKey]
}

export function withAgentChannelDelivery<T extends AgentRuntimeContext>(context: T, deliveryTracker: AgentChannelDeliveryTracker): T {
  return {
    ...context,
    channelDelivery: deliveryTracker.delivery,
    [agentChannelDeliveryTrackerKey]: deliveryTracker,
  }
}

export async function readAgentChannelDeliveries(state: Pick<StateAdapter, "get" | "getList">, limit = 100, scopePrefix?: string): Promise<AgentChannelDeliveryInspection[]> {
  const ids = await state.get<string[]>(indexKey) || []
  const stored: Array<AgentChannelDelivery & { events: AgentChannelDeliveryEvent[] }> = []
  const maximum = Math.max(0, limit)
  for (const id of [...ids].reverse()) {
    if (stored.length >= maximum) break
    const delivery = await state.get<AgentChannelDelivery>(deliveryRecordKey(id))
    if (!delivery || (scopePrefix && !delivery.scope.startsWith(scopePrefix))) continue
    stored.push({ ...delivery, events: await state.getList<AgentChannelDeliveryEvent>(deliveryEventsKey(id)) })
  }
  return stored.map((delivery) => {
    let reopened = false
    const status = delivery.events.reduce<AgentChannelDeliveryStatus>((current, event) => {
      if (event.type === "duplicate") {
        reopened = true
        return current
      }
      if (current === "completed" || current === "failed" || current === "rejected") {
        if ((!reopened && event.type !== "invocation.started") || (event.type !== "accepted" && event.type !== "retrying" && event.type !== "invocation.started")) return current
        reopened = false
      }
      if (event.type === "invocation.started") return "running"
      if (event.type === "received") return "received"
      if (event.type === "accepted" || event.type === "completed" || event.type === "failed" || event.type === "queued" || event.type === "rejected" || event.type === "retrying") return event.type
      return current
    }, "received")
    return { ...delivery, status }
  })
}
