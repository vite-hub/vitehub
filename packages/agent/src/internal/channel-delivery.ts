import type { StateAdapter } from "chat"

import type { AgentChannelDelivery, AgentChannelDeliveryEvent, AgentChannelDeliveryEventInput, AgentChannelDeliveryInspection, AgentChannelDeliveryStatus, AgentRuntimeContext } from "../types.ts"

const retentionMs = 30 * 24 * 60 * 60 * 1000
const maximumEvents = 256
const maximumDeliveries = 10_000
const indexKey = "deliveries:index"

export const agentChannelDeliveryTrackerKey: symbol = Symbol.for("vitehub.agent.channel-delivery")

export interface AgentChannelDeliveryTracker {
  delivery: AgentChannelDelivery
  duplicate: boolean
  event(input: AgentChannelDeliveryEventInput): Promise<AgentChannelDeliveryEvent>
}

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
  return event
}

function tracker(state: StateAdapter, delivery: AgentChannelDelivery, duplicate: boolean): AgentChannelDeliveryTracker {
  return {
    delivery,
    duplicate,
    event: async (input) => await appendEvent(state, delivery, input),
  }
}

export async function openAgentChannelDelivery(state: StateAdapter, input: Omit<AgentChannelDelivery, "id" | "receivedAt">): Promise<AgentChannelDeliveryTracker> {
  const candidate: AgentChannelDelivery = {
    ...input,
    id: token(),
    receivedAt: new Date().toISOString(),
  }
  const created = await state.setIfNotExists(sourceKey(candidate), candidate, retentionMs)
  const delivery = created ? candidate : (await state.get<AgentChannelDelivery>(sourceKey(candidate))) || candidate
  await state.set(deliveryRecordKey(delivery.id), delivery, retentionMs)
  if (created) await state.appendToList(indexKey, delivery.id, { maxLength: maximumDeliveries })
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
  const stored = await Promise.all(
    [...new Set([...ids].reverse())].map(async (id) => {
      const delivery = await state.get<AgentChannelDelivery>(deliveryRecordKey(id))
      if (!delivery) return
      return { ...delivery, events: await state.getList<AgentChannelDeliveryEvent>(deliveryEventsKey(id)) }
    }),
  )
  return stored
    .filter((delivery): delivery is AgentChannelDelivery & { events: AgentChannelDeliveryEvent[] } => delivery !== undefined)
    .filter(delivery => !scopePrefix || delivery.scope.startsWith(scopePrefix))
    .slice(0, Math.max(0, limit))
    .map((delivery) => ({
      ...delivery,
      status: delivery.events.reduce<AgentChannelDeliveryStatus>((status, event) => {
        if (event.type === "invocation.started") return "running"
        if (event.type === "received") return "received"
        if (event.type === "accepted" || event.type === "completed" || event.type === "failed" || event.type === "queued" || event.type === "rejected" || event.type === "retrying") return event.type
        return status
      }, "received"),
    }))
}
