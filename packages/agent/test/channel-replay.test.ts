import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { pendingAgentInvocationAnnotation } from "../src/invocations.ts"
import { defineAgent } from "../src/index.ts"
import { handleChannelReplayRequest } from "../src/channel-replay.ts"
import { channelReplayRunId, createMemoryAgentInvocationStore, defineAgentInvocations, describeChannelHistory, replayChannel } from "../src/server.ts"

interface Email {
  folder: string
  id: string
  subject: string
}

const emails: Email[] = [
  { folder: "inbox", id: "m1", subject: "Invoice" },
  { folder: "inbox", id: "m2", subject: "Receipt" },
  { folder: "archive", id: "m3", subject: "Old" },
  { folder: "inbox", id: "m4", subject: "Ticket" },
  { folder: "inbox", id: "m5", subject: "Offer" },
]

function mailbox(options: { maxLimit?: number, triggerRun?: { channelId?: string, origin?: string, threadId?: string } } = {}) {
  const load = vi.fn(async ({ cursor, limit, query }: { cursor?: string, limit: number, query: { folder?: string } }) => {
    const matching = emails.filter(email => !query.folder || email.folder === query.folder)
    const offset = cursor ? matching.findIndex(email => email.id === cursor) + 1 : 0
    return matching.slice(offset, offset + limit)
  })
  const history = defineCollection(load, {
    cursor: (email: Email) => email.id,
    cursorSchema: v.string(),
    defaultLimit: 2,
    maxLimit: options.maxLimit ?? 2,
    querySchema: v.object({ folder: v.optional(v.picklist(["archive", "inbox"])) }),
  })
  const label = vi.fn()
  const channel = defineChannel("mailbox", {
    history: { collection: history, key: email => email.id },
    message: {
      data: v.object({ id: v.string() }),
      methods: {
        label(context, name: string) {
          label(context.message.id, name)
        },
      },
    },
    messages: false,
    triggers: {
      received: defineChannelTrigger({
        input: v.object({ folder: v.string(), id: v.string(), subject: v.string() }),
        invoke: (_context, email) => ({
          input: { prompt: email.subject },
          message: { id: email.id },
          ...(options.triggerRun ? { run: { runId: "trigger-run", ...options.triggerRun } } : {}),
        }),
      }),
    },
  })
  return { channel, label, load }
}

function labeller(options: { invocations?: ReturnType<typeof defineAgentInvocations>, maxLimit?: number, triggerRun?: { channelId?: string, origin?: string, threadId?: string } } = {}) {
  const { channel, label, load } = mailbox(options)
  const run = vi.fn(async ({ input }: { input: { prompt?: unknown } }) => `label:${String(input.prompt)}`)
  const agent = defineAgent({
    channels: { mailbox: channel },
    driver: { run },
    hooks: {
      async "agent:finish"(event) {
        if (event.message?.channel === "mailbox" && event.text) await event.message.label(event.text)
      },
    },
    ...(options.invocations ? { invocations: options.invocations } : {}),
    runtime: false,
  })
  return { agent, label, load, run }
}

it("encodes Channel and item keys without collisions", () => {
  expect(channelReplayRunId("a:b", "c")).not.toBe(channelReplayRunId("a", "b:c"))
  expect(channelReplayRunId("a%3Ab", "c")).not.toBe(channelReplayRunId("a:b", "c"))
})

it("claims overlapping replays before executing the Driver", async () => {
  const store = createMemoryAgentInvocationStore()
  // Separate Invocation definitions model two hosts sharing one durable store.
  const first = labeller({ invocations: defineAgentInvocations({ store }) })
  const second = labeller({ invocations: defineAgentInvocations({ store }) })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  first.run.mockImplementation(async () => { await gate; return "label" })
  const firstReplay = replayChannel(first.agent, "mailbox", { limit: 1 })
  await vi.waitFor(() => expect(first.run).toHaveBeenCalledOnce())
  // Model the losing host having read absence before the first host claimed the item.
  vi.spyOn(second.agent.invocations!, "getByRunId").mockResolvedValue(undefined)
  const result = await replayChannel(second.agent, "mailbox", { limit: 1 })
  expect(result).toMatchObject({ processed: 0, skipped: 1 })
  expect(second.run).not.toHaveBeenCalled()
  release()
  expect(await firstReplay).toMatchObject({ processed: 1, skipped: 0 })
})

it("reports an unavailable claim store as failed instead of an existing item", async () => {
  const store = createMemoryAgentInvocationStore()
  vi.spyOn(store, "claim").mockImplementation(async () => { throw new Error("store unavailable") })
  const { agent, run } = labeller({ invocations: defineAgentInvocations({ store }) })
  expect(await replayChannel(agent, "mailbox", { limit: 1 })).toMatchObject({ failed: 1, processed: 0, skipped: 0 })
  expect(run).not.toHaveBeenCalled()
})

function memoryInvocations() {
  return defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
}

describe("replayChannel()", () => {
  it.each([false, true])("rejects an empty HTTP cursor before reading history or invoking with force=%s", async force => {
    const { agent, label, load, run } = labeller({ invocations: memoryInvocations() })
    const request = new Request("http://localhost/channels/replay", {
      body: JSON.stringify({ channel: "mailbox", cursor: "", force }),
      method: "POST",
    })
    const response = await handleChannelReplayRequest(agent, await request.json())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "AGENT_R0936" })
    expect(load).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(label).not.toHaveBeenCalled()
  })

  it("replays protected Channels without authenticating the host HTTP request", async () => {
    const { agent, run } = labeller({ invocations: memoryInvocations() })
    const channel = agent.channels?.mailbox
    if (!channel) throw new Error("Expected mailbox Channel.")
    channel.webhooks = [{ secretHeader: "x-provider-secret", secretToken: "secret" }]
    const result = await replayChannel(agent, "mailbox", {
      limit: 1,
      runtime: { memo: (_key, create) => create(), request: new Request("https://console.test/_vitehub/channels/replay", { method: "POST" }), runtime: "unknown", waitUntil: () => {} },
    })
    expect(result).toMatchObject({ failed: 0, processed: 1 })
    expect(run).toHaveBeenCalledOnce()
  })

  it("preserves inherited run metadata while overriding its run ID", async () => {
    const invocations = memoryInvocations()
    const { agent } = labeller({ invocations })
    const result = await replayChannel(agent, "mailbox", {
      limit: 1,
      runtime: { memo: (_key, create) => create(), run: { annotations: { task: "backfill" }, channelId: "mailbox", origin: "dev", runId: "host-run", threadId: "dev-thread" }, runtime: "unknown", waitUntil: () => {} },
    })
    expect(await invocations.getByRunId(result.items[0]!.id)).toMatchObject({ annotations: { task: "backfill" }, channelId: "mailbox", origin: "dev", threadId: "dev-thread" })
  })

  it("persists trigger run metadata on the replay reservation", async () => {
    const invocations = memoryInvocations()
    const { agent } = labeller({ invocations, triggerRun: { channelId: "trigger-channel", origin: "provider", threadId: "trigger-thread" } })
    const result = await replayChannel(agent, "mailbox", { limit: 1 })
    expect(await invocations.getByRunId(result.items[0]!.id)).toMatchObject({ channelId: "trigger-channel", origin: "provider", threadId: "trigger-thread" })
  })

  it("reports inline objects with workflow-shaped fields as completed", async () => {
    const { channel } = mailbox()
    const agent = defineAgent({ channels: { mailbox: channel }, invocations: memoryInvocations(), driver: { run: () => ({ id: "item", provider: "custom", status: "success" }) }, runtime: false })
    const result = await replayChannel(agent, "mailbox", { limit: 1 })
    expect(result.items[0]).toMatchObject({ status: "completed" })
  })

  it("pages history through the Channel trigger and skips items it replayed before", async () => {
    const invocations = memoryInvocations()
    const { agent, label, load } = labeller({ invocations })

    const first = await replayChannel(agent, "mailbox", { query: { folder: "inbox" } })
    expect(first).toMatchObject({ failed: 0, nextCursor: null, processed: 4, skipped: 0 })
    expect(first.items.map(item => [item.key, item.status])).toEqual([["m1", "completed"], ["m2", "completed"], ["m4", "completed"], ["m5", "completed"]])
    expect(first.items[0]?.id).toBe(channelReplayRunId("mailbox", "m1"))
    expect(label.mock.calls).toEqual([["m1", "label:Invoice"], ["m2", "label:Receipt"], ["m4", "label:Ticket"], ["m5", "label:Offer"]])
    expect(load).toHaveBeenCalledTimes(2)
    await expect(invocations.getByRunId(channelReplayRunId("mailbox", "m1"))).resolves.toMatchObject({ status: "completed" })

    label.mockClear()
    const second = await replayChannel(agent, "mailbox", { query: { folder: "inbox" } })
    expect(second).toMatchObject({ processed: 0, skipped: 4 })
    expect(second.items.every(item => item.reason === "existing")).toBe(true)
    expect(label).not.toHaveBeenCalled()
  })

  it("keeps completed inline side effects skipped when finish persistence is lost", async () => {
    const store = createMemoryAgentInvocationStore()
    const update = store.update.bind(store)
    const invocations = defineAgentInvocations({ store: { ...store, update: async (id, input, token) => {
      if (input.status && input.status !== "running") return undefined
      return await update(id, input, token)
    } } })
    const { agent, run, label } = labeller({ invocations })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    try {
      expect(await replayChannel(agent, "mailbox", { limit: 1, runtime })).toMatchObject({ processed: 1, failed: 0 })
      expect(run).toHaveBeenCalledOnce()
      expect(label).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(61_000)
      expect((await invocations.getByRunId(channelReplayRunId("mailbox", "m1")))?.status).toBe("running")
      expect(await replayChannel(agent, "mailbox", { limit: 1, runtime })).toMatchObject({ processed: 0, skipped: 1, failed: 0 })
      expect(run).toHaveBeenCalledOnce()
      expect(label).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it("does not execute inline side effects without a durable running marker", async () => {
    const store = createMemoryAgentInvocationStore()
    const update = store.update.bind(store)
    const invocations = defineAgentInvocations({ store: { ...store, update: async (id, input, token) => {
      if (input.status) return undefined
      return await update(id, input, token)
    } } })
    const { agent, run, label } = labeller({ invocations })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    try {
      const result = await replayChannel(agent, "mailbox", { limit: 1, runtime })
      expect(result).toMatchObject({ processed: 0, failed: 1 })
      expect(result.items[0]?.error).toContain("Could not persist the Invocation running state before execution")
      expect(run).not.toHaveBeenCalled()
      expect(label).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(61_000)
      expect((await invocations.getByRunId(channelReplayRunId("mailbox", "m1")))?.status).toBe("pending")
      expect(await replayChannel(agent, "mailbox", { limit: 1, runtime })).toMatchObject({ processed: 0, skipped: 1, failed: 0 })
      expect(run).not.toHaveBeenCalled()
      expect(label).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each(["create", "claim"])("recovers an ambiguous %s reservation before retrying history replay", async operation => {
    const store = createMemoryAgentInvocationStore()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const blocked = new Promise<void>(resolve => { started = resolve })
    let delayed = false
    const pause = async (name: string) => { if (name === operation && !delayed) { delayed = true; started(); await gate } }
    const invocations = defineAgentInvocations({ store: {
      ...store,
      create: async (...args: Parameters<typeof store.create>) => { await pause("create"); return await store.create(...args) },
      claim: async (...args: Parameters<typeof store.claim>) => { await pause("claim"); return await store.claim(...args) },
    } })
    const { agent, run, label } = labeller({ invocations })
    const runtime = { memo: vi.fn(), run: { runId: "host-run", annotations: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`tag${i}`, i])) }, runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    const initial = replayChannel(agent, "mailbox", { limit: 1, runtime })
    try {
      await blocked
      await vi.advanceTimersByTimeAsync(1_001)
      expect((await initial).failed).toBe(1)
      expect(run).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect((await invocations.getByRunId(channelReplayRunId("mailbox", "m1")))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(true)
      const retry = await replayChannel(agent, "mailbox", { limit: 1, runtime })
      expect(retry).toMatchObject({ failed: 0, processed: 1, skipped: 0 })
      expect(run).toHaveBeenCalledOnce()
      expect(label).toHaveBeenCalledOnce()
      expect((await replayChannel(agent, "mailbox", { limit: 1, runtime })).skipped).toBe(1)
    } finally { release(); await initial; vi.useRealTimers() }
  })

  it.each([false, undefined] as const)("claims before an asynchronous trigger write and recovers pending items according to runtime %s", async runtime => {
    const invocations = memoryInvocations()
    let entered!: () => void
    let release!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let fail = true
    const invoke = vi.fn(async () => {
      entered()
      await gate
      if (fail) throw new Error("Trigger preparation failed")
      return { input: { prompt: "hello" } }
    })
    const channel = defineChannel("mailbox", {
      history: { collection: defineCollection(async () => [emails[0]!], { cursor: email => email.id, cursorSchema: v.string() }), key: email => email.id },
      triggers: { received: defineChannelTrigger({ input: v.object({ folder: v.string(), id: v.string(), subject: v.string() }), invoke }) },
    })
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, invocations, runtime })
    const first = replayChannel(agent, "mailbox", { limit: 1 })
    try {
      await Promise.race([running, first])
      expect((await replayChannel(agent, "mailbox", { limit: 1 })).skipped).toBe(1)
      expect(invoke).toHaveBeenCalledOnce()
      release()
      expect((await first).failed).toBe(1)
      expect(run).not.toHaveBeenCalled()
      fail = false
      if (runtime === undefined) {
        expect((await replayChannel(agent, "mailbox", { limit: 1 })).skipped).toBe(1)
        expect(invoke).toHaveBeenCalledOnce()
        expect(run).not.toHaveBeenCalled()
        expect((await replayChannel(agent, "mailbox", { force: true, limit: 1 })).processed).toBe(1)
      } else {
        expect((await replayChannel(agent, "mailbox", { limit: 1 })).processed).toBe(1)
      }
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(run).toHaveBeenCalledOnce()
    } finally { release(); await first }
  })

  it("replays existing items again with force", async () => {
    const invocations = memoryInvocations()
    const { agent, label } = labeller({ invocations })
    await replayChannel(agent, "mailbox", { limit: 1 })
    label.mockClear()

    const forced = await replayChannel(agent, "mailbox", { force: true, limit: 1 })
    expect(forced).toMatchObject({ processed: 1, skipped: 0 })
    expect(forced.items[0]?.id).toMatch(new RegExp(`^${channelReplayRunId("mailbox", "m1")}:`))
    expect(label).toHaveBeenCalledWith("m1", "label:Invoice")
  })

  it("records message writes in a dry run and keeps live replay available", async () => {
    const invocations = memoryInvocations()
    const { agent, label, run } = labeller({ invocations })

    const dryRun = await replayChannel(agent, "mailbox", { dryRun: true, limit: 2 })
    expect(dryRun).toMatchObject({ processed: 2 })
    expect(dryRun.items[0]?.id).toBe(channelReplayRunId("mailbox", "m1", { dryRun: true }))
    expect(run).toHaveBeenCalledTimes(2)
    expect(label).not.toHaveBeenCalled()

    const live = await replayChannel(agent, "mailbox", { limit: 2 })
    expect(live).toMatchObject({ processed: 2, skipped: 0 })
    expect(label).toHaveBeenCalledTimes(2)
  })

  it("stops at the limit and resumes from the returned cursor", async () => {
    const invocations = memoryInvocations()
    const { agent } = labeller({ invocations, maxLimit: 10 })

    const first = await replayChannel(agent, "mailbox", { limit: 3 })
    expect(first.items.map(item => item.key)).toEqual(["m1", "m2", "m3"])
    expect(first.nextCursor).toEqual(expect.any(String))

    const rest = await replayChannel(agent, "mailbox", { cursor: first.nextCursor!, limit: 10 })
    expect(rest.items.map(item => item.key)).toEqual(["m4", "m5"])
    expect(rest).toMatchObject({ nextCursor: null, skipped: 0 })
  })

  it("rejects an invalid query, cursor, or Channel before it starts Invocations", async () => {
    const invocations = memoryInvocations()
    const { agent, run } = labeller({ invocations })

    await expect(replayChannel(agent, "mailbox", { query: { folder: "spam" } })).rejects.toMatchObject({ code: "AGENT_R0937" })
    await expect(replayChannel(agent, "mailbox", { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "AGENT_R0938" })
    await expect(replayChannel(agent, "unknown")).rejects.toMatchObject({ code: "AGENT_R0933" })
    await expect(replayChannel(agent, "mailbox", { limit: 0 })).rejects.toMatchObject({ code: "AGENT_R0936" })
    expect(run).not.toHaveBeenCalled()
  })

  it("requires Agent Invocations for a live replay without force", async () => {
    const { agent } = labeller()
    await expect(replayChannel(agent, "mailbox")).rejects.toMatchObject({ code: "AGENT_R0934" })
    await expect(replayChannel(agent, "mailbox", { dryRun: true, limit: 1 })).resolves.toMatchObject({ processed: 1 })
  })

  it("reports trigger validation failures per item and continues", async () => {
    const invocations = memoryInvocations()
    const { agent } = labeller({ invocations })
    const channel = agent.channels?.mailbox
    if (!channel?.history) throw new Error("Expected mailbox history.")
    const original = channel.history.collection
    channel.history.collection = {
      ...original,
      page: async () => ({ items: [{ id: "bad" }, emails[0]], nextCursor: null }),
      parseQuery: original.parseQuery,
    }

    const result = await replayChannel(agent, "mailbox")
    expect(result).toMatchObject({ failed: 1, processed: 1 })
    expect(result.items[0]).toMatchObject({ key: "bad", status: "failed" })
  })

  it("describes the history query as JSON Schema", () => {
    const { agent } = labeller()
    expect(describeChannelHistory(agent, "mailbox")).toMatchObject({
      channel: "mailbox",
      query: { properties: { folder: { enum: ["archive", "inbox"] } }, type: "object" },
      trigger: "received",
    })
  })
})

describe("defineChannel({ history })", () => {
  it("rejects history without a Collection, key, or unambiguous trigger", () => {
    const collection = defineCollection(async () => [], { cursor: () => "", cursorSchema: v.string() })
    const triggers = {
      a: { invoke: () => ({ input: {} }) },
      b: { invoke: () => ({ input: {} }) },
    }
    // SAFETY: These runtime checks cover JavaScript callers that bypass the typed options.
    expect(() => defineChannel("x", { history: { key: () => "" } as never, triggers })).toThrow(/requires a Collection/)
    expect(() => defineChannel("x", { history: { collection } as never, triggers })).toThrow(/requires key/)
    expect(() => defineChannel("x", { history: { collection, key: () => "" }, triggers })).toThrow(/requires trigger when the Channel has 2 triggers/)
    expect(() => defineChannel("x", { history: { collection, key: () => "", trigger: "c" }, triggers })).toThrow(/must name one of the Channel triggers: a, b/)
    expect(defineChannel("x", { history: { collection, key: () => "", trigger: "b" }, triggers }).history?.trigger).toBe("b")
  })

  it("rejects raw Channel histories with multiple triggers and no explicit trigger", async () => {
    const { channel } = mailbox()
    const rawChannel = {
      ...channel,
      history: { ...channel.history, trigger: undefined },
      triggers: { ...channel.triggers, other: channel.triggers?.received },
    }
    const agent = defineAgent({ channels: { mailbox: rawChannel } as never, driver: { run: () => "ok" }, runtime: false })
    await expect(replayChannel(agent, "mailbox", { force: true })).rejects.toMatchObject({ code: "AGENT_R0933" })
  })

  it("rejects ambiguous history on a raw AgentChannelDefinition", async () => {
    const load = vi.fn(async () => [{ id: "m1" }])
    const collection = defineCollection(load, {
      cursor: (item: { id: string }) => item.id,
      cursorSchema: v.string(),
    })
    const invoke = (name: string) => ({ input: { prompt: name } })
    const agent = defineAgent({
      channels: {
        raw: {
          kind: "raw",
          history: { collection, key: (item: { id: string }) => item.id },
          triggers: {
            first: { invoke: () => invoke("first") },
            second: { invoke: () => invoke("second") },
          },
        },
      },
      driver: { run: vi.fn() },
      runtime: false,
    })

    await expect(replayChannel(agent, "raw", { dryRun: true })).rejects.toMatchObject({ code: "AGENT_R0933" })
    expect(load).not.toHaveBeenCalled()
  })

  it("rejects a history trigger that is absent from a raw definition", async () => {
    const collection = defineCollection(async () => [], {
      cursor: (item: { id: string }) => item.id,
      cursorSchema: v.string(),
    })
    const agent = defineAgent({
      channels: {
        raw: {
          kind: "raw",
          history: { collection, key: (item: { id: string }) => item.id, trigger: "missing" },
          triggers: { first: { invoke: () => ({ input: { prompt: "first" } }) } },
        },
      },
      driver: { run: vi.fn() },
      runtime: false,
    })

    await expect(replayChannel(agent, "raw", { dryRun: true })).rejects.toMatchObject({
      code: "AGENT_R0930",
      message: expect.stringContaining('Channel "raw" history trigger must name one of the Channel triggers: first.'),
    })
  })
})
