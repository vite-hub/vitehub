import type { StateAdapter } from "chat"

import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject, isRuntimeString, isRuntimeUndefined } from "./runtime-value.ts"

export interface AgentWebhookQueueDelivery {
  concurrencyGroup: string
  concurrencyKey?: string
  concurrencyLimit: number
  channelDeliveryId?: string
  deliveryId: string
  enqueuedAt: number
  invocation?: {
    input: unknown
    run?: unknown
  }
  leaseTtlMs: number
  rehydrate?: true
  request: {
    body: string
    headers: Record<string, string>
    method: string
    url: string
  }
  scope: string
  webhookId: string
}

export interface AgentWebhookQueueLease extends AgentWebhookQueueDelivery {
  attempts: number
  leaseExpiresAt: number
  leaseToken: string
}

export interface AgentWebhookQueueStateAdapter extends StateAdapter {
  claimWebhookDelivery(scope: string): Promise<AgentWebhookQueueLease | null>
  claimWebhookSteering(delivery: AgentWebhookQueueDelivery, leaseToken: string, leaseExpiresAt: number): Promise<boolean>
  completeWebhookDelivery(scope: string, deliveryId: string, leaseToken: string): Promise<boolean>
  enqueueWebhookDelivery(delivery: AgentWebhookQueueDelivery): Promise<boolean>
  extendWebhookDeliveryLease(scope: string, deliveryId: string, leaseToken: string, ttlMs: number): Promise<boolean>
  retryWebhookDelivery(scope: string, deliveryId: string, leaseToken: string, availableAt: number, options?: { incrementAttempts?: boolean }): Promise<boolean>
  webhookDeliveryScopes(): Promise<string[]>
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRuntimeObject(value) && Object.values(value).every(isRuntimeString)
}

export function parseAgentWebhookQueueDelivery(serialized: string): AgentWebhookQueueDelivery {
  const value: unknown = JSON.parse(serialized)
  if (
    !isRuntimeObject(value) ||
    !("concurrencyGroup" in value) ||
    !isRuntimeString(value.concurrencyGroup) ||
    ("concurrencyKey" in value && !isRuntimeUndefined(value.concurrencyKey) && !isRuntimeString(value.concurrencyKey)) ||
    !("concurrencyLimit" in value) ||
    !isRuntimeNumber(value.concurrencyLimit) ||
    ("channelDeliveryId" in value && !isRuntimeUndefined(value.channelDeliveryId) && !isRuntimeString(value.channelDeliveryId)) ||
    !("deliveryId" in value) ||
    !isRuntimeString(value.deliveryId) ||
    !("enqueuedAt" in value) ||
    !isRuntimeNumber(value.enqueuedAt) ||
    !("leaseTtlMs" in value) ||
    !isRuntimeNumber(value.leaseTtlMs) ||
    !("scope" in value) ||
    !isRuntimeString(value.scope) ||
    !("webhookId" in value) ||
    !isRuntimeString(value.webhookId) ||
    !("request" in value) ||
    !isRuntimeObject(value.request) ||
    !("body" in value.request) ||
    !isRuntimeString(value.request.body) ||
    !("headers" in value.request) ||
    !isStringRecord(value.request.headers) ||
    !("method" in value.request) ||
    !isRuntimeString(value.request.method) ||
    !("url" in value.request) ||
    !isRuntimeString(value.request.url) ||
    ("invocation" in value && !isRuntimeUndefined(value.invocation) && !isRuntimeObject(value.invocation)) ||
    ("rehydrate" in value && !isRuntimeUndefined(value.rehydrate) && value.rehydrate !== true)
  ) {
    throw new TypeError("[vitehub] Agent webhook queue contains an invalid delivery.")
  }
  // SAFETY: Every persisted webhook field with a runtime contract was validated above; invocation payloads remain unknown by design.
  return value as AgentWebhookQueueDelivery
}

export function hasAgentWebhookQueue(state: StateAdapter): state is AgentWebhookQueueStateAdapter {
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const candidate = state as Partial<AgentWebhookQueueStateAdapter>
  return (
    isRuntimeFunction(candidate.claimWebhookDelivery) &&
    isRuntimeFunction(candidate.claimWebhookSteering) &&
    isRuntimeFunction(candidate.completeWebhookDelivery) &&
    isRuntimeFunction(candidate.enqueueWebhookDelivery) &&
    isRuntimeFunction(candidate.extendWebhookDeliveryLease) &&
    isRuntimeFunction(candidate.retryWebhookDelivery) &&
    isRuntimeFunction(candidate.webhookDeliveryScopes)
  )
}
