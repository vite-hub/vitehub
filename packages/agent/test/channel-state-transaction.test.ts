import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import type { AgentChannelDispatchItem, AgentChannelPullPage, AgentTriggerFailedEvent } from "../src/channels.ts"
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
  | { kind: "pull" }

interface Hooks {
  failSeq?: number
  fetches: number[]
  gapAt?: number
  log: Change[]
  onRecord?: (change: Change) => void
  page?: (cursor: number) => AgentChannelPullPage<number>
  signal?: AbortSignal
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const changes = (count: number): Change[] => Array.from({ length: count }, (_, index) => ({ id: `r${(index % 3) + 1}`, seq: index + 1, text: `e${index + 1}` }))

function changeItem(change: Change): AgentChannelDispatchItem {
  return { input: change, key: `log:${change.seq}`, order: { key: change.id, version: change.seq } }
}

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
          if (payload.kind === "dispatch") return Response.json(await context.dispatch(payload.items, { queue: true, trigger: "record" }))
          try {
            return Response.json(await context.pull({
              fetch(cursor) {
                hooks.fetches.push(cursor)
                if (hooks.page) return hooks.page(cursor)
                const page = hooks.log.filter(change => change.seq >= cursor).slice(0, 2)
                async function* items() {
                  for (const change of page) yield changeItem(change)
                }
                const next = cursor + page.length
                return { first: hooks.gapAt === cursor ? cursor + 1 : cursor, items: items(), more: next <= hooks.log.length, next }
              },
              initialCursor: 1,
              key: "log-cursor",
              signal: hooks.signal,
              trigger: "record",
            }))
          }
          catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        },
      }),
      record: defineChannelTrigger({
        failed,
        invoke(context, change: Change) {
          hooks.onRecord?.(change)
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
  const hooks: Hooks = { fetches: [], log: changes(7) }
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

describe("context.pull()", () => {
  it("resumes from the saved cursor and saves it only after every item of a page is admitted", async () => {
    const { channelKey, hooks, open } = await setup()
    const { post, state } = open()

    hooks.failSeq = 4
    expect((await post({ kind: "pull" })).status).toBe(500)
    // Page [1, 2] is saved. Page [3, 4] fails on 4: item 3 is admitted, the cursor stays 3.
    expect(await state.get(channelKey("log-cursor"))).toBe(3)
    expect(hooks.fetches).toEqual([1, 3])

    hooks.failSeq = undefined
    hooks.fetches = []
    const result = await json(await post({ kind: "pull" }))
    expect(hooks.fetches).toEqual([3, 5, 7])
    // Item 3 was admitted before, so its order version is stale now.
    expect(result).toEqual({ cursor: 8, pages: 3, queued: 4, skipped: 1 })
    expect(await state.get(channelKey("log-cursor"))).toBe(8)
  })

  it("continues from a raw cursor that earlier code saved under its key", async () => {
    const { channelKey, hooks, open } = await setup()
    const { post, state } = open()
    await post({ items: [], kind: "dispatch" })
    await state.set(channelKey("log-cursor"), 6)

    const result = await json(await post({ kind: "pull" }))

    expect(hooks.fetches[0]).toBe(6)
    expect(result).toMatchObject({ cursor: 8 })
  })

  it.each([
    ["a gap", (hooks: Hooks) => { hooks.gapAt = 1 }, "has a gap: expected cursor 1, received 2"],
    ["a cursor that moves back", (hooks: Hooks) => { hooks.page = () => ({ items: [], more: false, next: 0 }) }, "moved its cursor back from 1 to 0"],
    ["more items without progress", (hooks: Hooks) => { hooks.page = cursor => ({ items: [], more: true, next: cursor }) }, "reported more items without advancing its cursor 1"],
  ])("throws on %s before it admits the page", async (_name, configure, message) => {
    const { channelKey, hooks, open, runIds } = await setup()
    const { post, state } = open()
    configure(hooks)

    const response = await post({ kind: "pull" })

    expect(response.status).toBe(500)
    expect((await json(response)).error).toContain(message)
    expect(await state.get(channelKey("log-cursor"))).toBeNull()
    expect(runIds).toEqual([])
  })

  it("keeps the cursor on abort, and the next pull skips the admitted item as stale", async () => {
    const { channelKey, hooks, open, orderKey } = await setup()
    const { post, state } = open()
    hooks.log = [{ id: "r9", seq: 1, text: "e1" }, { id: "r9", seq: 2, text: "e2" }]
    const controller = new AbortController()
    hooks.signal = controller.signal
    hooks.onRecord = (change) => {
      if (change.seq === 1) controller.abort(new Error("stop"))
    }

    expect((await post({ kind: "pull" })).status).toBe(500)
    hooks.onRecord = undefined
    hooks.signal = undefined
    expect(await state.get(channelKey("log-cursor"))).toBeNull()
    expect(await state.get(orderKey("r9"))).toBe(1)

    const result = await json(await post({ kind: "pull" }))
    expect(result).toEqual({ cursor: 3, pages: 1, queued: 1, skipped: 1 })
  })
})
