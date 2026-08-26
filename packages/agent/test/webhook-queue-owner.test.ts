import { describe, expect, it, vi } from "vitest"

import { createAgentWebhookQueue } from "../src/internal/webhook-queue.ts"

import type { AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../src/internal/webhook-queue.ts"

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
  // SAFETY: The queue owner only exercises the webhook queue methods supplied by this focused fixture.
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

    await expect(queue.admit(registration, lease)).resolves.toBe(true)
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

  it("rediscovers every persisted scope when registration wins startup", async () => {
    const fixture = queueState([delivery("persisted")])
    const { state } = fixture
    state.webhookDeliveryScopes = vi.fn(async () => ["scope:declared", "scope:persisted"])
    state.claimWebhookDelivery = vi.fn(async (scope: string) => scope === "scope:persisted" ? fixture.queued.shift() ?? null : null)
    const execute = vi.fn(async () => undefined)
    const queue = createAgentWebhookQueue({
      execute,
      resolveBackendId: async () => "backend",
      resolveWaitUntil: async () => undefined,
      retryMs: 5,
    })
    const stop = queue.resume(async (registrar) => {
      await registrar.register({ backendId: "backend", options: {}, scope: "scope:declared", state })
      registrar.track(state, {}, "scope:")
    }, { scopePrefix: "scope" })

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await stop()
  })

  it("waits for scope discovery before stop resolves", async () => {
    const { state } = queueState()
    let finishDiscovery!: () => void
    const discoveryBlocked = new Promise<void>((resolve) => {
      finishDiscovery = resolve
    })
    const queue = createAgentWebhookQueue({
      execute: async () => undefined,
      resolveWaitUntil: async () => undefined,
    })
    const stop = queue.resume(async (registrar) => {
      await discoveryBlocked
      registrar.track(state, {})
    })

    const stopping = stop()
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    finishDiscovery()
    await stopping
    expect(stopped).toBe(true)
  })
})
