import type { StateAdapter } from "chat"

export interface AgentWebhookQueueDelivery {
  concurrencyGroup: string
  concurrencyKey?: string
  concurrencyLimit: number
  deliveryId: string
  enqueuedAt: number
  invocation?: {
    input: unknown
    run?: unknown
  }
  leaseTtlMs: number
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
  completeWebhookDelivery(scope: string, deliveryId: string, leaseToken: string): Promise<boolean>
  enqueueWebhookDelivery(delivery: AgentWebhookQueueDelivery): Promise<boolean>
  extendWebhookDeliveryLease(scope: string, deliveryId: string, leaseToken: string, ttlMs: number): Promise<boolean>
  retryWebhookDelivery(scope: string, deliveryId: string, leaseToken: string, availableAt: number): Promise<boolean>
  webhookDeliveryScopes(): Promise<string[]>
}

export function hasAgentWebhookQueue(state: StateAdapter): state is AgentWebhookQueueStateAdapter {
  const candidate = state as Partial<AgentWebhookQueueStateAdapter>
  return typeof candidate.claimWebhookDelivery === "function"
    && typeof candidate.completeWebhookDelivery === "function"
    && typeof candidate.enqueueWebhookDelivery === "function"
    && typeof candidate.extendWebhookDeliveryLease === "function"
    && typeof candidate.retryWebhookDelivery === "function"
    && typeof candidate.webhookDeliveryScopes === "function"
}
