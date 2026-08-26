import { describe, expect, it, vi } from "vitest"

import { createAgentWebhookQueue } from "../src/internal/webhook-queue.ts"

import type { AgentWebhookQueueDelivery, AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../src/internal/webhook-queue.ts"

function delivery(id: string, attempts = 0): AgentWebhookQueueLease {
  return {
    attempts,
    concurrencyGroup: "agent:default",
    concurrencyLimit: 1,
    deliveryId: id,
    enqueuedAt: 0,
    leaseExpiresAt: Date.now() + 1_000,
    leaseToken: `lease-${id}`,
    leaseTtlMs: 1_000,
    request: { body: "", headers: {}, method: "POST", url: "https://example.com/webhook" },
    scope: "scope",
    webhookId: "github",
  }
}

function queueState(claims: AgentWebhookQueueLease[] = []) {
  const queued = [...claims]
  const state = {
    claimWebhookDelivery: vi.fn(async () => queued.shift() ?? null),
    claimWebhookSteering: vi.fn(async () => true),
    completeWebhookDelivery: vi.fn(async () => true),
    enqueueWebhookDelivery: vi.fn(async () => true),
    extendWebhookDeliveryLease: vi.fn(async () => true),
    retryWebhookDelivery: vi.fn(async () => true),
    webhookDeliveryScopes: vi.fn(async () => ["scope"]),
  } as unknown as AgentWebhookQueueStateAdapter
  return { queued, state }
}

describe("Agent webhook queue owner", () => {
  it("admits a delivery, drains it once, and ignores duplicate registrations", async () => {
    const lease = delivery("one")
    const { state } = queueState([lease])
    const execute = vi.fn(async () => undefined)
    const queue = createAgentWebhookQueue({ execute, resolveWaitUntil: async () => undefined })
    const registration = { backendId: "backend", options: {}, scope: "scope", state }

    await expect(queue.admit(registration, lease as AgentWebhookQueueDelivery)).resolves.toBe(true)
    await queue.idle()
    await queue.register(registration)
    await queue.idle()

    expect(state.enqueueWebhookDelivery).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it("isolates concurrent scopes and aborts active work before stop resolves", async () => {
    const first = queueState([delivery("one")])
    const second = queueState([delivery("two")])
    const stopped = vi.fn()
    const execute = vi.fn(async ({ lifecycleSignal }: { lifecycleSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => lifecycleSignal.addEventListener("abort", () => {
        stopped()
        resolve()
      }, { once: true }))
      return Date.now()
    })
    const queue = createAgentWebhookQueue({ execute, resolveWaitUntil: async () => undefined })

    await Promise.all([
      queue.register({ backendId: "first", options: {}, scope: "scope", state: first.state }),
      queue.register({ backendId: "second", options: {}, scope: "scope", state: second.state }),
    ])
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    await queue.stop()

    expect(stopped).toHaveBeenCalledTimes(2)
  })

  it("rediscovers persisted scopes after restart", async () => {
    const fixture = queueState([delivery("persisted")])
    const { state } = fixture
    state.claimWebhookDelivery = vi.fn(async (scope: string) => scope === "scope" ? fixture.queued.shift() ?? null : null)
    const execute = vi.fn(async () => undefined)
    const queue = createAgentWebhookQueue({
      execute,
      resolveBackendId: async () => "backend",
      resolveWaitUntil: async () => undefined,
      retryMs: 5,
    })
    const stop = queue.resume(async (registrar) => {
      registrar.track(state, {}, "scope")
      await registrar.register({ backendId: "backend", options: {}, scope: "scope:declared", state })
    }, { scopePrefix: "scope" })

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await stop()
  })
})
