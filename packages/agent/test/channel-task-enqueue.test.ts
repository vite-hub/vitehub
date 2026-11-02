import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "@vite-hub/agent/channels"
import { defineAgent } from "../src/index.ts"
import { cancelChannelTask, enqueueChannelTask } from "../src/server.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import * as channelTasks from "../src/channel-tasks.ts"
import { hubAgent } from "../src/vite.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { objected?: () => boolean, resume?: boolean, sharedTask?: boolean } = {}) {
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
              close: { run: (_context, { input }) => { ran.push({ at: Date.now(), data: input.data }) } },
              "close:duplicate": { run: (_context, { input }) => { ran.push({ at: Date.now(), data: input.data }) } },
            },
          }),
          ...(options.sharedTask ? {
            other: defineChannelTrigger({
              webhooks: [],
              invoke: () => new Response(null, { status: 200 }),
              tasks: {
                "close-duplicate": { run: (_context, { input }) => { ran.push({ at: Date.now(), data: input.data }) } },
              },
            }),
          } : {}),
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
  let stop = async () => {}
  const resume = () => stop = handler.resume(routeOptions)
  if (options.resume !== false) resume()
  cleanups.push(async () => {
    await stop()
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  return {
    deliveries: () => handler.deliveries(new Request("https://example.com/api/airtable/webhook", { method: "POST" }), "airtable", routeOptions),
    failed,
    ran,
    resume,
    state,
    async restart() {
      await stop()
      await state.disconnect()
      await state.connect()
      stop = createChannelWebhookRouteHandler(agent as never).resume(routeOptions)
    },
    async stop() {
      await stop()
    },
  }
}

async function installGeneratedHost(resume: () => () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channel-task-host-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  await mkdir(join(root, "server", "agents"), { recursive: true })
  await writeFile(join(root, "server", "agents", "bot.ts"), "export default {}")
  const plugin = hubAgent({ providers: { state: { provider: "libsql", url: "file:state.sqlite" } } })
  if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
  // SAFETY: The config hook reads only command and root from this fixture.
  await plugin.configResolved.call({} as never, { command: "build", root } as never)
  const source = await readFile(join(root, ".vitehub/agent/webhook-queue-plugin.ts"), "utf8")
  const body = source.replace(/^import .*\n/gm, "").replaceAll("import.meta.prerender", "false").replaceAll("import.meta.dev", "false").replace("export default ", "return ")
  const delayedStart = vi.fn()
  // SAFETY: Evaluate only the plugin generated above, substituting the queue and Nitro host boundaries.
  const install = new Function("resumeWebhookQueues", "warmWebhookRoutes", "onAgentRoutesLoad", "registerChannelTaskQueueStarter", "setTimeout", "onShutdown", "drainInlineChatInvocations", "webhookQueueShutdown", body)(
    resume,
    async () => {},
    () => {},
    channelTasks.registerChannelTaskQueueStarter,
    delayedStart,
    (_app: unknown, _name: string, drain: (context: { timeoutMs: number }) => Promise<void>) => { cleanups.push(() => drain({ timeoutMs: 0 })) },
    async () => {},
    async () => {},
  )
  install({})
  return delayedStart
}

describe("enqueueChannelTask()", () => {
  it.each(["enqueue", "cancel"])("starts the generated persistent Nitro queue for an immediate server-code %s call", async (operation) => {
    const { ran, resume } = await setup({ resume: false })
    const delayedStart = await installGeneratedHost(resume)
    expect(delayedStart).toHaveBeenCalledWith(expect.any(Function), 1000)
    const [error] = operation === "enqueue"
      ? await enqueueChannelTask("airtable", "close-duplicate", { data: { immediate: true } })
      : await cancelChannelTask("airtable", "close-duplicate", { key: "absent" })
    expect(error).toBeNull()
    if (operation === "enqueue") await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 5_000 })
  })

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
    const { deliveries, ran } = await setup()
    const [, first] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 1 } }, { delayMs: 300, key: "pair:recA:recB" })
    const [error] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 2 } }, { delayMs: 300, key: "pair:recA:recB" })
    expect(error).toBeNull()
    expect((await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)?.status).toBe("completed")

    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(ran.map(item => item.data)).toEqual([{ version: 2 }])
  })

  it("keeps task names and keys containing colons distinct during replacement and cancellation", async () => {
    const { deliveries, ran } = await setup()
    const [, first] = await enqueueChannelTask("airtable", "close", { data: { version: 1 } }, { delayMs: 400, key: "duplicate:123" })
    const [, second] = await enqueueChannelTask("airtable", "close:duplicate", { data: { version: 2 } }, { delayMs: 400, key: "123" })
    expect((await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)?.status).toBe("queued")
    await expect(cancelChannelTask("airtable", "close", { key: "duplicate:123" })).resolves.toEqual([null, { cancelled: 1 }])
    expect((await deliveries()).find(item => item.sourceId === `task:${second!.deliveryId}`)?.status).toBe("queued")
    await vi.waitFor(() => expect(ran.map(item => item.data)).toEqual([{ version: 2 }]), { timeout: 5_000 })
  })

  it("isolates the same task key on different triggers during replacement and cancellation", async () => {
    const { deliveries, ran } = await setup({ sharedTask: true })
    const [, first] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 1 } }, { delayMs: 500, key: "pair", trigger: "record" })
    const [, second] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 2 } }, { delayMs: 500, key: "pair", trigger: "other" })
    expect((await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)?.status).toBe("queued")
    await expect(cancelChannelTask("airtable", "close-duplicate", { key: "pair", trigger: "record" })).resolves.toEqual([null, { cancelled: 1 }])
    expect((await deliveries()).find(item => item.sourceId === `task:${second!.deliveryId}`)?.status).toBe("queued")
    await vi.waitFor(() => expect(ran.map(item => item.data)).toEqual([{ version: 2 }]), { timeout: 5_000 })
  })

  it.each([
    ["replacement", true],
    ["cancellation", true],
    ["replacement", false],
    ["cancellation", false],
  ])("recovers %s settlement after a journal failure (restart: %s)", async (operation, reconnect) => {
    const { deliveries, ran, restart, state } = await setup()
    const [, first] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 1 } }, { delayMs: 30_000, key: "pair" })
    const append = state.appendToList.bind(state)
    const failedWrite = vi.spyOn(state, "appendToList").mockImplementation(async (key, value, options) => {
      if (typeof value === "object" && value !== null && "type" in value && value.type === "superseded") throw new Error("journal unavailable")
      return await append(key, value, options)
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (operation === "replacement") {
        const [error] = await enqueueChannelTask("airtable", "close-duplicate", { data: { version: 2 } }, { key: "pair" })
        expect(error).toBeNull()
        await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 5_000 })
      }
      else {
        await expect(cancelChannelTask("airtable", "close-duplicate", { key: "pair" })).resolves.toEqual([null, { cancelled: 1 }])
      }
      expect((await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)?.status).toBe("queued")
      const scope = (await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)!.scope
      expect(await state.pendingWebhookDeliverySettlements(scope)).toEqual([expect.objectContaining({ deliveryId: first!.deliveryId })])
      failedWrite.mockRestore()
      if (reconnect) await restart()
      await vi.waitFor(async () => expect((await deliveries()).find(item => item.sourceId === `task:${first!.deliveryId}`)?.status).toBe("completed"), { timeout: 2_000 })
      await vi.waitFor(async () => expect(await state.pendingWebhookDeliverySettlements(scope)).toEqual([]))
      expect(ran.map(item => item.data)).toEqual(operation === "replacement" ? [{ version: 2 }] : [])
    }
    finally {
      failedWrite.mockRestore()
      errors.mockRestore()
    }
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
