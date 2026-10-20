import { describe, expect, it, vi } from "vitest"

import { createAgentWebhookQueue, webhookQueueShutdown } from "../src/internal/webhook-queue.ts"

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
    queuedWebhookDeliveries: vi.fn(async () => []),
    webhookDeliveries: vi.fn(async () => []),
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

  it("lets active deliveries finish within VITEHUB_SHUTDOWN_DRAIN_MS before it aborts them", async () => {
    vi.stubEnv("VITEHUB_SHUTDOWN_DRAIN_MS", "1000")
    const finished = vi.fn()
    const aborted = vi.fn()
    let release!: () => void
    const execute = vi.fn(async ({ lifecycleSignal }: { lifecycleSignal: AbortSignal }) => {
      lifecycleSignal.addEventListener("abort", aborted, { once: true })
      await new Promise<void>((resolve) => { release = resolve })
      finished()
      return Date.now()
    })
    const queue = createAgentWebhookQueue({ execute, resolveWaitUntil: async () => undefined })
    try {
      await queue.register({ backendId: "backend", options: {}, scope: "scope", state: queueState([delivery("one")]).state })
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

      const stopped = queue.stop()
      const shutdown = webhookQueueShutdown()
      setTimeout(() => release(), 50)
      await stopped
      await shutdown

      expect(finished).toHaveBeenCalledOnce()
      expect(aborted).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("aborts deliveries that outlast VITEHUB_SHUTDOWN_DRAIN_MS", async () => {
    vi.stubEnv("VITEHUB_SHUTDOWN_DRAIN_MS", "50")
    const aborted = vi.fn()
    const execute = vi.fn(async ({ lifecycleSignal }: { lifecycleSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => lifecycleSignal.addEventListener("abort", () => {
        aborted()
        resolve()
      }, { once: true }))
      return Date.now()
    })
    const queue = createAgentWebhookQueue({ execute, resolveWaitUntil: async () => undefined })
    try {
      await queue.register({ backendId: "backend", options: {}, scope: "scope", state: queueState([delivery("one")]).state })
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

      await queue.stop()
      await webhookQueueShutdown()

      expect(aborted).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllEnvs()
    }
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

  it("leaves a scope registered by name to the queue that registered it", async () => {
    const scope = "webhook:bot:airtable:"
    const fixture = queueState([{ ...delivery("airtable"), scope }])
    const { state } = fixture
    state.webhookDeliveryScopes = vi.fn(async () => [scope])
    const prefixExecute = vi.fn(async () => undefined)
    const prefixQueue = createAgentWebhookQueue({
      execute: prefixExecute,
      resolveBackendId: async () => "backend",
      resolveWaitUntil: async () => undefined,
      retryMs: 100,
    })
    const ownerExecute = vi.fn(async () => undefined)
    const ownerQueue = createAgentWebhookQueue({ execute: ownerExecute, resolveWaitUntil: async () => undefined, retryMs: 100 })

    // The Agent queue resumes first and finds the scope only through its prefix.
    const stopPrefix = prefixQueue.resume(async registrar => registrar.track(state, {}, "webhook:bot:"))
    await vi.waitFor(() => expect(state.webhookDeliveryScopes).toHaveBeenCalled(), { interval: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    const stopOwner = ownerQueue.resume(async (registrar) => {
      await registrar.register({ backendId: "backend", options: {}, scope, state })
    })

    await vi.waitFor(() => expect(ownerExecute).toHaveBeenCalledOnce(), { interval: 1 })
    await new Promise(resolve => setTimeout(resolve, 250))
    await Promise.all([stopPrefix(), stopOwner()])
    expect(prefixExecute).not.toHaveBeenCalled()
  })

  it("stops a prefix drain when a named owner registers after its first drain", async () => {
    const scope = "webhook:bot:airtable:"
    const fixture = queueState([delivery("airtable")])
    const { state } = fixture
    state.webhookDeliveryScopes = vi.fn(async () => [scope])
    let releaseClaim!: () => void
    const claimBlocked = new Promise<void>(resolve => { releaseClaim = resolve })
    let firstClaim = true
    state.claimWebhookDelivery = vi.fn(async () => {
      if (firstClaim) {
        firstClaim = false
        await claimBlocked
        return null
      }
      return fixture.queued.shift() ?? null
    })
    const prefixExecute = vi.fn(async () => undefined)
    const prefixQueue = createAgentWebhookQueue({
      execute: prefixExecute,
      resolveBackendId: async () => "backend",
      resolveWaitUntil: async () => undefined,
      retryMs: 5,
    })
    const ownerExecute = vi.fn(async () => undefined)
    const ownerQueue = createAgentWebhookQueue({ execute: ownerExecute, resolveWaitUntil: async () => undefined, retryMs: 50 })

    const stopPrefix = prefixQueue.resume(async registrar => registrar.track(state, {}, "webhook:bot:"))
    await vi.waitFor(() => expect(state.claimWebhookDelivery).toHaveBeenCalledOnce(), { interval: 1 })
    const stopOwner = ownerQueue.resume(async registrar => {
      await registrar.register({ backendId: "backend", options: {}, scope, state })
    })
    fixture.queued.push(delivery("airtable"))
    releaseClaim()

    await vi.waitFor(() => expect(ownerExecute).toHaveBeenCalled(), { timeout: 200, interval: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    await Promise.all([stopPrefix(), stopOwner()])
    expect(prefixExecute).not.toHaveBeenCalled()
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
