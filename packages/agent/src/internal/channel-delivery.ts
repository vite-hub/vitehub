import type { StateAdapter } from "chat"

import type { AgentChannelDelivery, AgentChannelDeliveryEvent, AgentChannelDeliveryEventInput, AgentChannelDeliveryInspection, AgentChannelDeliveryStatus, AgentRuntimeContext } from "../types.ts"

const retentionMs = 30 * 24 * 60 * 60 * 1000
const maximumEvents = 256
const maximumDeliveries = 10_000
const indexKey = "deliveries:index"
const activeDeliveries = new Map<string, AgentChannelDeliveryTracker>()
let workflowResolver: AgentChannelDeliveryWorkflowResolver | undefined

export const agentChannelDeliveryTrackerKey: symbol = Symbol.for("vitehub.agent.channel-delivery")
export const agentChannelDeliveryWorkflowContextKey = "vitehub.channelDelivery"

export interface AgentChannelDeliveryWorkflowBinding {
  channelId: string
  deliveryId: string
  provider: string
  state: "chat" | "webhook"
}

export interface AgentChannelDeliveryTracker {
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

function sourceKey(delivery: Pick<AgentChannelDelivery, "provider" | "scope" | "sourceId">): string {
  return `deliveries:source:${encodeURIComponent(`${delivery.provider}:${delivery.scope}:${delivery.sourceId}`)}`
}

function token(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    delivery,
    duplicate,
    event: async (input) => await appendEvent(state, delivery, input),
  }
  activeDeliveries.set(delivery.id, value)
  return value
}

export function activeAgentChannelDelivery(deliveryId: string): AgentChannelDeliveryTracker | undefined {
  return activeDeliveries.get(deliveryId)
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
  const indexed = await state.getList<string>(indexKey)
  if (!indexed.includes(delivery.id)) await state.appendToList(indexKey, delivery.id, { maxLength: maximumDeliveries })
  const opened = tracker(state, delivery, !created)
  await opened.event({ type: opened.duplicate ? "duplicate" : "received" })
  return opened
}

export async function resumeAgentChannelDelivery(state: StateAdapter, deliveryId: string): Promise<AgentChannelDeliveryTracker | undefined> {
  const stored = await state.get<AgentChannelDelivery>(deliveryRecordKey(deliveryId))
  return stored ? tracker(state, stored, false) : undefined
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
  const ids = await state.getList<string>(indexKey)
  const stored: Array<AgentChannelDelivery & { events: AgentChannelDeliveryEvent[] }> = []
  const maximum = Math.max(0, limit)
  for (const id of new Set([...ids].reverse())) {
    if (stored.length >= maximum) break
    const delivery = await state.get<AgentChannelDelivery>(deliveryRecordKey(id))
    if (!delivery || (scopePrefix && !delivery.scope.startsWith(scopePrefix))) continue
    stored.push({ ...delivery, events: await state.getList<AgentChannelDeliveryEvent>(deliveryEventsKey(id)) })
  }
  return stored.map((delivery) => ({
      ...delivery,
      status: delivery.events.reduce<AgentChannelDeliveryStatus>((status, event) => {
        if (status === "completed" || status === "failed" || status === "rejected") return status
        if (event.type === "invocation.started") return "running"
        if (event.type === "received") return "received"
        if (event.type === "accepted" || event.type === "completed" || event.type === "failed" || event.type === "queued" || event.type === "rejected" || event.type === "retrying") return event.type
        return status
      }, "received"),
    }))
}
