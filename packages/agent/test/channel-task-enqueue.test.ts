import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "@vite-hub/agent/channels"
import { defineAgent } from "../src/index.ts"
import { cancelChannelTask, enqueueChannelTask } from "../src/server.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { objected?: () => boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-task-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  const ran: { data: unknown, at: number, runId?: string, annotations?: unknown }[] = []
  const failed = vi.fn()
  const agent = defineAgent({
    channels: {
      airtable: defineChannel("airtable", {
        messages: false,
        triggers: {
          webhook: defineChannelTrigger({ invoke: () => new Response(null, { status: 200 }) }),
          record: defineChannelTrigger({
            webhooks: [],
            invoke: () => new Response(null, { status: 200 }),
            tasks: {
              "close-duplicate": {
                prepare: () => options.objected?.() ? ignored("objected") : undefined,
                run: (_context, { input, run }) => {
                  ran.push({ annotations: run?.annotations, at: Date.now(), data: input.data, runId: run?.runId })
                },
                failed,
              },
            },
          }),
        },
        webhooks: { path: "/api/airtable/webhook", secretToken: false },
      }),
    },
    driver: { run: () => "unexpected Agent run" },
  })
  await state.connect()
  // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentName: "bot", webhookState: state }
  let stop = handler.resume(routeOptions)
  cleanups.push(async () => {
    await stop()
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  return {
    deliveries: () => handler.deliveries(new Request("https://example.com/api/airtable/webhook", { method: "POST" }), "airtable", routeOptions),
    failed,
    ran,
    async restart() {
      await stop()
      stop = createChannelWebhookRouteHandler(agent as never).resume(routeOptions)
    },
    async stop() {
      await stop()
    },
  }
}

describe("enqueueChannelTask()", () => {
  it("runs a declared Channel task after its start time, through the Channel's prepare and run", async () => {
    const { deliveries, ran } = await setup()
    const enqueuedAt = Date.now()
    const [error, receipt] = await enqueueChannelTask("airtable", "close-duplicate", { data: { closeId: "recA" } }, {
      delayMs: 400,
      run: { annotations: { "airtable.record": "recA" } },
    })
    expect(error).toBeNull()
    expect(receipt).toMatchObject({ deliveryId: expect.stringMatching(/^task:close-duplicate:/), runId: expect.stringMatching(/^airtable:task:close-duplicate:/) })

    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 5_000 })
    expect(ran[0]).toMatchObject({ annotations: { "airtable.record": "recA" }, data: { closeId: "recA" }, runId: receipt!.runId })
    expect(ran[0]!.at).toBeGreaterThanOrEqual(enqueuedAt + 400)
    await vi.waitFor(async () => expect((await deliveries()).find(item => item.sourceId === `task:${receipt!.deliveryId}`)?.status).toBe("completed"))
  })

  it("replaces a queued task with the same key, so only the newest input runs", async () => {
    const { ran } = await setup()
    await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 1 } }, { delayMs: 300, key: "pair:recA:recB" })
    const [error] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 2 } }, { delayMs: 300, key: "pair:recA:recB" })
    expect(error).toBeNull()

    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(ran.map(item => item.data)).toEqual([{ version: 2 }])
  })

  it("lets prepare drop the task when live state changed", async () => {
    let objected = false
    const { deliveries, ran } = await setup({ objected: () => objected })
    const [, receipt] = await enqueueChannelTask("airtable", "close-duplicate", { data: {} }, { delayMs: 200 })
    objected = true
    await vi.waitFor(async () => expect((await deliveries()).find(item => item.sourceId === `task:${receipt!.deliveryId}`)?.status).toBe("completed"), { timeout: 5_000 })
    expect(ran).toEqual([])
  })

  it("keeps a queued task across a restart", async () => {
    const { ran, restart } = await setup()
    await enqueueChannelTask("airtable", "close-duplicate", { data: { closeId: "recA" } }, { delayMs: 500 })
    await restart()
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 6_000 })
  })

  it("returns an error for an undeclared task or a Channel without a running queue", async () => {
    await setup()
    const [unknownTask, none] = await enqueueChannelTask("airtable", "missing", { data: {} })
    expect(none).toBeNull()
    expect(unknownTask?.message).toContain('No trigger of Channel "airtable" declares task "missing"')

    const [noQueue] = await enqueueChannelTask("slack", "close-duplicate", { data: {} })
    expect(noQueue?.message).toContain('Channel "slack" has no running webhook queue')

    const [both] = await enqueueChannelTask("airtable", "close-duplicate", { data: {} }, { delayMs: 1, notBefore: Date.now() })
    expect(both?.message).toContain("notBefore or delayMs, not both")
  })
})

describe("cancelChannelTask()", () => {
  it("drops the queued task with the key, and the Console shows it as completed", async () => {
    const { deliveries, ran } = await setup()
    const [, receipt] = await enqueueChannelTask("airtable", "close-duplicate", { data: {} }, { delayMs: 500, key: "pair:recA:recB" })

    await expect(cancelChannelTask("airtable", "close-duplicate", { key: "pair:recA:recB" })).resolves.toEqual([null, { cancelled: 1 }])
    await expect(cancelChannelTask("airtable", "close-duplicate", { key: "pair:recA:recB" })).resolves.toEqual([null, { cancelled: 0 }])

    await new Promise(resolve => setTimeout(resolve, 2_000))
    expect(ran).toEqual([])
    expect((await deliveries()).find(item => item.sourceId === `task:${receipt!.deliveryId}`)?.status).toBe("completed")
  })
})
