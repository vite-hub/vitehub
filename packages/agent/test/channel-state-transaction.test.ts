import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

interface Payload {
  delayMs?: number
  id: string
  ignore?: boolean
  invalidLimit?: boolean
  key: string
  reject?: boolean
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function createAgent(prefix: { channelState?: string }, run: (context: { run?: { runId?: string } }) => string) {
  const channel = defineChannel("t", {
    messages: false,
    triggers: {
      webhook: defineChannelTrigger({
        invoke(context, { payload }: { payload: Payload }) {
          const state = context.channelState!
          prefix.channelState = state.keyPrefix
          return state.transaction<{ n: number }>(`counter:${payload.key}`, async (counter) => {
            const n = counter.value?.n ?? 0
            if (payload.delayMs) await new Promise(resolve => setTimeout(resolve, payload.delayMs))
            counter.set({ n: n + 1 })
            if (payload.reject) return new Response(null, { status: 409 })
            if (payload.ignore) return ignored("counted")
            return {
              input: { prompt: `count ${payload.key}` },
              run: { runId: payload.id },
              webhook: payload.invalidLimit
                ? { concurrencyLimit: 0, deliveryId: payload.id }
                : { deliveryId: payload.id, serialize: `counter:${payload.key}` },
            }
          })
        },
      }),
    },
    webhooks: { durableState: true, secretToken: false },
  })
  return defineAgent({ channels: { t: channel }, driver: { run } })
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-channel-state-"))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  const prefix: { channelState?: string } = {}
  const runIds: string[] = []
  const run = vi.fn((context: { run?: { runId?: string } }) => {
    if (context.run?.runId) runIds.push(context.run.runId)
    return "ok"
  })
  const handler = createChannelWebhookRouteHandler(createAgent(prefix, run) as never)
  const stop = handler.resume({ agentName: "agent", webhookState: state })
  cleanups.push(async () => {
    await stop()
    await state.disconnect()
    await rm(directory, { force: true, recursive: true })
  })
  const post = (payload: Payload) => handler(new Request("https://example.com/api/t", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), "t", { agentName: "agent", webhookState: state })
  const queuedIds = async () => (await Promise.all((await state.webhookDeliveryScopes()).map(scope => state.webhookDeliveries(scope))))
    .flat()
    .map(delivery => delivery.deliveryId)
  const channelKey = (key: string) => `${prefix.channelState}${key}`
  return { channelKey, post, queuedIds, run, runIds, state }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: Every route answer in these tests is a JSON object.
  return await response.json() as Record<string, unknown>
}

describe("channelState.transaction()", () => {
  it("serializes concurrent deliveries on one key, so no write is lost", async () => {
    const { channelKey, post, runIds, state } = await setup()

    const responses = await Promise.all([
      post({ delayMs: 100, id: "d1", key: "c1" }),
      post({ delayMs: 100, id: "d2", key: "c1" }),
    ])

    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 2 })
    await vi.waitFor(() => expect(runIds.toSorted()).toEqual(["d1", "d2"]))
  })

  it("commits at once when the trigger answers ignored()", async () => {
    const { channelKey, post, run, state } = await setup()

    const response = await post({ id: "d1", ignore: true, key: "c1" })

    await expect(json(response)).resolves.toMatchObject({ reason: "counted" })
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it("writes nothing for a Response of 400 or above", async () => {
    const { channelKey, post, state } = await setup()

    expect((await post({ id: "d1", key: "c1", reject: true })).status).toBe(409)
    expect(await state.get(channelKey("counter:c1"))).toBeNull()
  })

  it("writes nothing and releases the lock when the delivery fails after the decision", async () => {
    const { channelKey, post, state } = await setup()

    await expect(post({ id: "d1", invalidLimit: true, key: "c1" })).rejects.toThrow("concurrencyLimit must be a positive integer")
    expect(await state.get(channelKey("counter:c1"))).toBeNull()

    const started = Date.now()
    expect((await post({ id: "d2", key: "c1" })).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
  })

  it("rolls back the staged write when the queue admission fails in the same SQLite transaction", async () => {
    const { channelKey, post, queuedIds, state } = await setup()
    // SAFETY: The test replaces the private queue insert to fail inside the commit transaction.
    const insert = vi.spyOn(state as never as { insertWebhookDelivery: () => Promise<boolean> }, "insertWebhookDelivery")
      .mockRejectedValueOnce(new Error("simulated crash during admission"))

    await expect(post({ id: "d1", key: "c1" })).rejects.toThrow("simulated crash during admission")

    expect(insert).toHaveBeenCalledOnce()
    expect(await state.get(channelKey("counter:c1"))).toBeNull()
    expect(await queuedIds()).toEqual([])
  })

  it("admits and writes nothing when the lock expired before the commit", async () => {
    const { channelKey, post, queuedIds, state } = await setup()
    const commit = state.commitWebhookState.bind(state)
    vi.spyOn(state, "commitWebhookState").mockImplementationOnce(async (writes) => {
      for (const lock of writes.locks) await state.forceReleaseLock(lock.threadId)
      return await commit(writes)
    })

    await expect(post({ id: "d1", key: "c1" })).rejects.toThrow("expired before its writes were committed")

    expect(await state.get(channelKey("counter:c1"))).toBeNull()
    expect(await queuedIds()).toEqual([])
  })

  it("checks the locks, queues, then writes on a State without commitWebhookState", async () => {
    const { channelKey, post, queuedIds, runIds, state } = await setup()
    Object.defineProperty(state, "commitWebhookState", { value: undefined })

    expect((await post({ id: "d1", key: "c1" })).status).toBe(200)
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    await vi.waitFor(() => expect(runIds).toEqual(["d1"]))

    const extendLock = state.extendLock.bind(state)
    const extend = vi.spyOn(state, "extendLock").mockImplementation(async (lock, ttlMs) => lock.threadId.endsWith(":transaction") ? false : await extendLock(lock, ttlMs))
    await expect(post({ id: "d2", key: "c1" })).rejects.toThrow("expired before its writes were committed")
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    expect(await queuedIds()).not.toContain("d2")
    extend.mockRestore()
  })
})
