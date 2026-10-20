import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import type { AgentChannelDispatchItem, AgentTriggerFailedEvent } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import type { ViteHubSqliteAgentStateAdapter } from "../src/state/sqlite.ts"

interface Change {
  id: string
  seq: number
  text: string
}

type Payload =
  | { kind: "tx", key: string, id: string, delayMs?: number, ignore?: boolean, reject?: boolean, invalidLimit?: boolean }
  | { kind: "dispatch", items: AgentChannelDispatchItem[] }

interface Hooks {
  failSeq?: number
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function createAgent(hooks: Hooks, prefix: { channelState?: string }, run: (context: { run?: { runId?: string } }) => string, failed?: (event: AgentTriggerFailedEvent) => void) {
  const channel = defineChannel("t", {
    messages: false,
    triggers: {
      webhook: defineChannelTrigger({
        async invoke(context, { payload }: { payload: Payload }) {
          const state = context.channelState!
          prefix.channelState = state.keyPrefix
          if (payload.kind === "tx") {
            return await state.transaction<{ n: number }>(`counter:${payload.key}`, async (counter) => {
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
          }
          return Response.json(await context.dispatch(payload.items, { queue: true, trigger: "record" }))
        },
      }),
      record: defineChannelTrigger({
        failed,
        invoke(context, change: Change) {
          if (hooks.failSeq === change.seq) throw new Error(`boom ${change.seq}`)
          return context.channelState!.transaction(`record:${change.id}`, (record) => {
            record.set({ last: change.seq, text: change.text })
            if (change.text === "skip") return ignored("skip")
            return {
              input: { prompt: change.text },
              run: { runId: `record:${change.id}:${change.seq}` },
              webhook: { deliveryId: `record:${change.id}:${change.seq}`, serialize: `record:${change.id}` },
            }
          })
        },
        webhooks: [],
      }),
    },
    webhooks: { durableState: true, secretToken: false },
  })
  return defineAgent({ channels: { t: channel }, driver: { run } })
}

async function setup(options: { failed?: (event: AgentTriggerFailedEvent) => void, run?: (context: { run?: { runId?: string } }) => string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-channel-state-"))
  const url = `file:${join(directory, "state.sqlite")}`
  const hooks: Hooks = {}
  const prefix: { channelState?: string } = {}
  const runIds: string[] = []
  const run = vi.fn((context: { run?: { runId?: string } }) => {
    if (context.run?.runId) runIds.push(context.run.runId)
    return options.run?.(context) ?? "ok"
  })
  const stops: Array<() => Promise<void> | void> = []
  const states: ViteHubSqliteAgentStateAdapter[] = []
  const open = () => {
    const state = createLibsqlAgentState({ url })
    const handler = createChannelWebhookRouteHandler(createAgent(hooks, prefix, run, options.failed) as never)
    stops.push(handler.resume({ agentName: "agent", webhookState: state }))
    states.push(state)
    const post = (payload: Payload) => handler(new Request("https://example.com/api/t", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), "t", { agentName: "agent", webhookState: state })
    return { post, state }
  }
  cleanups.push(async () => {
    for (const stop of stops) await stop()
    for (const state of states) await state.disconnect()
    await rm(directory, { force: true, recursive: true })
  })
  const queuedIds = async (state: ViteHubSqliteAgentStateAdapter) => (await Promise.all((await state.webhookDeliveryScopes()).map(scope => state.webhookDeliveries(scope))))
    .flat()
    .map(delivery => delivery.deliveryId)
  const channelKey = (key: string) => `${prefix.channelState}${key}`
  const orderKey = (key: string) => `${prefix.channelState!.slice(0, -"channel-state:".length)}order:t.record:${key}`
  return { channelKey, hooks, open, orderKey, queuedIds, run, runIds }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: Every route answer in these tests is a JSON object.
  return await response.json() as Record<string, unknown>
}

describe("channelState.transaction()", () => {
  it("serializes concurrent deliveries on one key, so no write is lost", async () => {
    const { channelKey, open, runIds } = await setup()
    const { post, state } = open()

    const responses = await Promise.all([
      post({ delayMs: 100, id: "d1", key: "c1", kind: "tx" }),
      post({ delayMs: 100, id: "d2", key: "c1", kind: "tx" }),
    ])

    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 2 })
    await vi.waitFor(() => expect(runIds.toSorted()).toEqual(["d1", "d2"]))
  })

  it("commits at once when the trigger answers ignored()", async () => {
    const { channelKey, open, run } = await setup()
    const { post, state } = open()

    const response = await post({ id: "d1", ignore: true, key: "c1", kind: "tx" })

    await expect(json(response)).resolves.toMatchObject({ reason: "counted" })
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it("writes nothing for a Response of 400 or above", async () => {
    const { channelKey, open } = await setup()
    const { post, state } = open()

    expect((await post({ id: "d1", key: "c1", kind: "tx", reject: true })).status).toBe(409)
    expect(await state.get(channelKey("counter:c1"))).toBeNull()
  })

  it("writes nothing and releases the lock when the delivery fails after the decision", async () => {
    const { channelKey, open } = await setup()
    const { post, state } = open()

    await expect(post({ id: "d1", invalidLimit: true, key: "c1", kind: "tx" })).rejects.toThrow("concurrencyLimit must be a positive integer")
    expect(await state.get(channelKey("counter:c1"))).toBeNull()

    const started = Date.now()
    expect((await post({ id: "d2", key: "c1", kind: "tx" })).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
  })

  it("rolls back the staged write when the queue admission fails in the same SQLite transaction", async () => {
    const { channelKey, open, queuedIds } = await setup()
    const { post, state } = open()
    // SAFETY: The test replaces the private queue insert to fail inside the commit transaction.
    const insert = vi.spyOn(state as never as { insertWebhookDelivery: () => Promise<boolean> }, "insertWebhookDelivery")
      .mockRejectedValueOnce(new Error("simulated crash during admission"))

    await expect(post({ id: "d1", key: "c1", kind: "tx" })).rejects.toThrow("simulated crash during admission")

    expect(insert).toHaveBeenCalledOnce()
    expect(await state.get(channelKey("counter:c1"))).toBeNull()
    expect(await queuedIds(state)).toEqual([])
  })

  it("admits and writes nothing when the lock expired before the commit", async () => {
    const { channelKey, open, queuedIds } = await setup()
    const { post, state } = open()
    const commit = state.commitWebhookState.bind(state)
    vi.spyOn(state, "commitWebhookState").mockImplementationOnce(async (writes) => {
      for (const lock of writes.locks) await state.forceReleaseLock(lock.threadId)
      return await commit(writes)
    })

    await expect(post({ id: "d1", key: "c1", kind: "tx" })).rejects.toThrow("expired before its writes were committed")

    expect(await state.get(channelKey("counter:c1"))).toBeNull()
    expect(await queuedIds(state)).toEqual([])
  })

  it("checks the locks, queues, then writes on a State without commitWebhookState", async () => {
    const { channelKey, open, queuedIds, runIds } = await setup()
    const { post, state } = open()
    Object.defineProperty(state, "commitWebhookState", { value: undefined })

    expect((await post({ id: "d1", key: "c1", kind: "tx" })).status).toBe(200)
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    await vi.waitFor(() => expect(runIds).toEqual(["d1"]))

    const extendLock = state.extendLock.bind(state)
    const extend = vi.spyOn(state, "extendLock").mockImplementation(async (lock, ttlMs) => lock.threadId.endsWith(":transaction") ? false : await extendLock(lock, ttlMs))
    await expect(post({ id: "d2", key: "c1", kind: "tx" })).rejects.toThrow("expired before its writes were committed")
    expect(await state.get(channelKey("counter:c1"))).toEqual({ n: 1 })
    expect(await queuedIds(state)).not.toContain("d2")
    extend.mockRestore()
  })
})

describe("queued dispatch with order", () => {
  const item = (seq: number, text = `o${seq}`): AgentChannelDispatchItem => ({ input: { id: "o1", seq, text }, key: `o:${seq}:${text}`, order: { key: "o1", version: seq } })
  const outcomes = (result: Record<string, unknown>) => (result.items as Array<{ reason?: string, status: string }>).map(entry => `${entry.status}:${entry.reason ?? ""}`)

  it("skips older and equal versions durably across a restart, and a failed item does not advance", async () => {
    const { channelKey, hooks, open, orderKey, runIds } = await setup()
    let { post, state } = open()

    const first = await json(await post({ items: [item(1), item(2), item(2, "again"), item(1, "old"), item(3, "skip"), item(4)], kind: "dispatch" }))
    expect(outcomes(first)).toEqual(["queued:", "queued:", "skipped:stale", "skipped:stale", "skipped:handled", "queued:"])
    expect(await state.get(orderKey("o1"))).toBe(4)
    expect(await state.get(channelKey("record:o1"))).toEqual({ last: 4, text: "o4" })

    // A new handler, queue and State connection on the same database.
    ;({ post, state } = open())
    const replay = await json(await post({ items: [item(4, "replay"), item(3, "replay"), item(5)], kind: "dispatch" }))
    expect(outcomes(replay)).toEqual(["skipped:stale", "skipped:stale", "queued:"])

    hooks.failSeq = 6
    await expect(post({ items: [item(6)], kind: "dispatch" })).rejects.toThrow("boom 6")
    hooks.failSeq = undefined
    expect(await state.get(orderKey("o1"))).toBe(5)
    expect(outcomes(await json(await post({ items: [item(6)], kind: "dispatch" })))).toEqual(["queued:"])

    // The deliveries of one record run one at a time.
    await vi.waitFor(() => expect(runIds.toSorted()).toEqual(["record:o1:1", "record:o1:2", "record:o1:4", "record:o1:5", "record:o1:6"]), { timeout: 15_000 })
  }, 20_000)

  it("runs the failed callback of the trigger that admitted the item", async () => {
    const failed = vi.fn()
    const { open } = await setup({
      failed,
      run: () => {
        throw new Error("agent failed")
      },
    })
    const { post } = open()

    await post({ items: [item(1)], kind: "dispatch" })

    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "record:o1:1" })), { timeout: 15_000 })
  }, 20_000)
})
