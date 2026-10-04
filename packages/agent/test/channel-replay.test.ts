import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { dispatchChannelItems } from "../src/channel-replay.ts"
import { defineAgent } from "../src/index.ts"
import { bindAgentInvocations, pendingAgentInvocationAnnotation } from "../src/invocations.ts"
import { channelMessageRunId, createMemoryAgentInvocationStore, defineAgentInvocations, describeChannelHistory, replayChannel } from "../src/server.ts"

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

function mailbox(options: { maxLimit?: number } = {}) {
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
        }),
      }),
    },
  })
  return { channel, label, load }
}

function labeller(options: { invocations?: ReturnType<typeof defineAgentInvocations>, maxLimit?: number } = {}) {
  const { channel, label, load } = mailbox(options)
  const run = vi.fn(({ input }: { input: { prompt?: unknown } }) => `label:${String(input.prompt)}`)
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

function memoryInvocations() {
  return defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
}

describe("replayChannel()", () => {
  it("rejects a history collection that repeats a pagination cursor", async () => {
    let page = 0
    const history = defineCollection(async () => {
      const email = emails[page++ === 0 ? 0 : 1]!
      return [email, email]
    }, {
      cursor: () => "cycle",
      cursorSchema: v.string(),
      defaultLimit: 1,
      maxLimit: 1,
      querySchema: v.object({}),
    })
    const channel = defineChannel("mailbox", {
      history: { collection: history, key: email => email.id },
      triggers: {
        received: defineChannelTrigger({
          input: v.object({ folder: v.string(), id: v.string(), subject: v.string() }),
          invoke: (_context, email) => ({ input: { prompt: email.subject }, message: { id: email.id } }),
        }),
      },
    })
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, runtime: false })

    await expect(replayChannel(agent, "mailbox", { force: true })).rejects.toMatchObject({
      code: "AGENT_R0936",
      message: '[vitehub] Channel "mailbox" history returned a repeated pagination cursor.',
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rejects a history collection that repeats the starting cursor", async () => {
    const history = defineCollection(async () => [emails[0]!], {
      cursor: () => "start",
      cursorSchema: v.string(),
      defaultLimit: 1,
      maxLimit: 1,
      querySchema: v.object({}),
    })
    history.page = async () => ({ items: [emails[0]!], nextCursor: "start" })
    const channel = defineChannel("mailbox", {
      history: { collection: history, key: email => email.id },
      triggers: {
        received: defineChannelTrigger({
          input: v.object({ folder: v.string(), id: v.string(), subject: v.string() }),
          invoke: (_context, email) => ({ input: { prompt: email.subject }, message: { id: email.id } }),
        }),
      },
    })
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, runtime: false })

    await expect(replayChannel(agent, "mailbox", { cursor: "start", force: true })).rejects.toMatchObject({
      code: "AGENT_R0936",
      message: '[vitehub] Channel "mailbox" history returned a repeated pagination cursor.',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("pages history through the Channel trigger and skips items it replayed before", async () => {
    const invocations = memoryInvocations()
    const { agent, label, load } = labeller({ invocations })

    const first = await replayChannel(agent, "mailbox", { query: { folder: "inbox" } })
    expect(first).toMatchObject({ failed: 0, nextCursor: null, processed: 4, skipped: 0 })
    expect(first.items.map(item => [item.key, item.status])).toEqual([["m1", "completed"], ["m2", "completed"], ["m4", "completed"], ["m5", "completed"]])
    expect(first.items[0]?.id).toBe(channelMessageRunId("mailbox", "m1"))
    expect(label.mock.calls).toEqual([["m1", "label:Invoice"], ["m2", "label:Receipt"], ["m4", "label:Ticket"], ["m5", "label:Offer"]])
    expect(load).toHaveBeenCalledTimes(2)
    await expect(invocations.getByRunId(channelMessageRunId("mailbox", "m1"))).resolves.toMatchObject({ status: "completed" })

    label.mockClear()
    const second = await replayChannel(agent, "mailbox", { query: { folder: "inbox" } })
    expect(second).toMatchObject({ processed: 0, skipped: 4 })
    expect(second.items.every(item => item.reason === "existing")).toBe(true)
    expect(label).not.toHaveBeenCalled()
  })

  it("keeps colon-bearing Channel names and message keys independent", async () => {
    const invocations = memoryInvocations()
    const { channel } = mailbox()
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { "a:b": channel, a: channel }, driver: { run }, invocations, runtime: false })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    const first = await dispatchChannelItems(agent, runtime, "a:b", [{ key: "c", input: emails[0]! }], { trigger: "received" })
    const second = await dispatchChannelItems(agent, runtime, "a", [{ key: "b:c", input: emails[0]! }], { trigger: "received" })
    expect(first.processed).toBe(1)
    expect(second.processed).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id)
    expect(channelMessageRunId("a:b", "c")).not.toBe(channelMessageRunId("a%3Ab", "c"))
    expect(channelMessageRunId("a", "b:c", { dryRun: true })).not.toBe(channelMessageRunId("a:b", "c", { dryRun: true }))
    const repeated = await dispatchChannelItems(agent, runtime, "a", [{ key: "b:c", input: emails[0]! }], { trigger: "received" })
    expect(repeated.skipped).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("atomically excludes a webhook dispatch racing history replay", async () => {
    const invocations = memoryInvocations()
    let entered = 0
    const channel = defineChannel("mailbox", {
      history: { collection: defineCollection(async () => [emails[0]!], { cursor: email => email.id, cursorSchema: v.string() }), key: email => email.id },
      triggers: { received: defineChannelTrigger({
        input: v.object({ folder: v.string(), id: v.string(), subject: v.string() }),
        invoke: async () => {
          entered++
          return { input: { prompt: "hello" } }
        },
      }) },
    })
    const run = vi.fn(() => "done")
    const finish = vi.fn()
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, hooks: { "agent:finish": finish }, invocations, runtime: false })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    const results = await Promise.all([
      replayChannel(agent, "mailbox", { runtime }),
      dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: emails[0]! }], { trigger: "received" }),
    ])
    expect(entered).toBe(1)
    expect(run).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.skipped + result.failed, 0)).toBe(1)
    expect(await dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: emails[0]! }], { trigger: "received" })).toMatchObject({ failed: 0, processed: 0, skipped: 1 })
  })

  it.each(["create", "claim"])("recovers an ambiguous %s reservation before a Gmail-style dispatch retry", async operation => {
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
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    const initial = replayChannel(agent, "mailbox", { limit: 1, runtime })
    try {
      await blocked
      await vi.advanceTimersByTimeAsync(1_001)
      expect((await initial).failed).toBe(1)
      expect(run).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      const retry = await dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: emails[0]! }], { trigger: "received" })
      expect(retry).toMatchObject({ failed: 0, processed: 1, skipped: 0 })
      expect(run).toHaveBeenCalledOnce()
      expect(label).toHaveBeenCalledOnce()
      expect((await replayChannel(agent, "mailbox", { limit: 1, runtime })).skipped).toBe(1)
    } finally { release(); await initial; vi.useRealTimers() }
  })

  it("keeps a late pending claim retryable until its cleanup releases ownership", async () => {
    const store = createMemoryAgentInvocationStore()
    let releaseClaim!: () => void
    const claimGate = new Promise<void>(resolve => { releaseClaim = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    let claimStarted!: () => void
    const started = new Promise<void>(resolve => { claimStarted = resolve })
    let cleanupStarted!: () => void
    const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve })
    let firstClaim = true
    let firstRelease = true
    const invocations = defineAgentInvocations({ store: {
      ...store,
      claim: async (...args: Parameters<typeof store.claim>) => {
        if (firstClaim) { firstClaim = false; claimStarted(); await claimGate }
        return await store.claim(...args)
      },
      release: async (...args: Parameters<typeof store.release>) => {
        if (firstRelease) { firstRelease = false; cleanupStarted(); await cleanupGate }
        return await store.release(...args)
      },
    } })
    const { agent, run, label } = labeller({ invocations })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    const initial = replayChannel(agent, "mailbox", { limit: 1, runtime })
    try {
      await started
      await vi.advanceTimersByTimeAsync(1_001)
      expect((await initial).failed).toBe(1)
      releaseClaim()
      await cleaning
      const overlapping = await dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: emails[0]! }], { trigger: "received" })
      expect(overlapping).toMatchObject({ failed: 1, processed: 0, skipped: 0 })
      expect(run).not.toHaveBeenCalled()
      releaseCleanup()
      await vi.advanceTimersByTimeAsync(0)
      const retry = await dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: emails[0]! }], { trigger: "received" })
      expect(retry).toMatchObject({ failed: 0, processed: 1, skipped: 0 })
      expect(run).toHaveBeenCalledOnce()
      expect(label).toHaveBeenCalledOnce()
    } finally { releaseClaim(); releaseCleanup(); await initial; vi.useRealTimers() }
  })

  it.each([
    { channelName: "mailbox", dryRun: false, key: "m1" },
    { channelName: "mail box:%", dryRun: false, key: "m 1:%" },
    { channelName: "mailbox", dryRun: true, key: "m1" },
    { channelName: "mail box:%", dryRun: true, key: "m 1:%" },
  ])("preserves legacy replay journals for $channelName/$key, dry run: $dryRun", async ({ channelName, dryRun, key }) => {
    const invocations = memoryInvocations()
    const { channel, label } = mailbox()
    if (!channel.history) throw new Error("Expected history")
    channel.history.key = () => key
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { [channelName]: channel }, driver: { run }, invocations, runtime: false })
    const legacyId = `${dryRun ? "channel-replay-dry-run" : "channel-replay"}:${channelName}:${key}`
    const journal = await bindAgentInvocations(invocations, { memo: vi.fn(), run: { runId: legacyId }, runtime: "unknown", waitUntil: () => {} })
    await journal?.running()
    await journal?.finish("completed")
    expect(await replayChannel(agent, channelName, { dryRun, limit: 1 })).toMatchObject({ failed: 0, processed: 0, skipped: 1 })
    expect(run).not.toHaveBeenCalled()
    expect(label).not.toHaveBeenCalled()
    expect(await replayChannel(agent, channelName, { dryRun, force: true, limit: 1 })).toMatchObject({ processed: 1, skipped: 0 })
    if (dryRun) expect(await replayChannel(agent, channelName, { limit: 1 })).toMatchObject({ processed: 1, skipped: 0 })
  })

  it.each([
    { channelName: "mailbox", key: "m 1", legacyKey: "m%201", named: false },
    { channelName: "mailbox", key: "m1", legacyKey: "m1", named: true },
  ])("keeps legacy replay identity scoped to the raw key and Agent: $key/$named", async ({ channelName, key, legacyKey, named }) => {
    const invocations = memoryInvocations()
    const { channel } = mailbox()
    channel.history!.key = () => key
    const run = vi.fn(() => "done")
    const agent = defineAgent({ ...(named ? { name: "current" } : {}), channels: { [channelName]: channel }, driver: { run }, invocations, runtime: false })
    const journal = await bindAgentInvocations(invocations, { memo: vi.fn(), run: { runId: `channel-replay:${channelName}:${legacyKey}` }, runtime: "unknown", waitUntil: () => {} }, named ? { agentName: "other" } : undefined)
    await journal?.running()
    await journal?.finish("completed")
    expect(await replayChannel(agent, channelName, { limit: 1 })).toMatchObject({ processed: 1, skipped: 0, failed: 0 })
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(["a:b", undefined])("does not assign a colliding raw legacy ID to another Channel with owner %s", async owner => {
    const invocations = memoryInvocations()
    const { channel } = mailbox()
    channel.history!.key = () => "b:c"
    const run = vi.fn(() => "done")
    const agent = defineAgent({ channels: { a: channel, "a:b": channel }, driver: { run }, invocations, runtime: false })
    const journal = await bindAgentInvocations(invocations, { memo: vi.fn(), run: { runId: "channel-replay:a:b:c", ...(owner ? { channelId: owner } : {}) }, runtime: "unknown", waitUntil: () => {} })
    await journal?.running()
    await journal?.finish("completed")
    const replay = await replayChannel(agent, "a", { limit: 1 })
    expect(replay).toMatchObject(owner ? { processed: 1, skipped: 0, failed: 0 } : { processed: 0, skipped: 0, failed: 1 })
    if (owner) expect(run).toHaveBeenCalledOnce()
    else {
      expect(run).not.toHaveBeenCalled()
      expect(await replayChannel(agent, "a", { limit: 1, force: true })).toMatchObject({ processed: 1, failed: 0 })
    }
  })

  it("marks started inline execution non-recoverable while its claim excludes concurrent replay", async () => {
    const invocations = memoryInvocations()
    const { channel } = mailbox()
    let entered!: () => void
    let release!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const agent = defineAgent({ channels: { mailbox: channel }, invocations, runtime: false, driver: { run: async () => { entered(); await gate; return "done" } } })
    const execution = replayChannel(agent, "mailbox", { limit: 1 })
    try {
      await Promise.race([running, execution])
      expect(await invocations.getByRunId(channelMessageRunId("mailbox", "m1"))).toMatchObject({ status: "running", annotations: { [pendingAgentInvocationAnnotation]: false } })
      expect((await replayChannel(agent, "mailbox", { limit: 1 })).skipped).toBe(1)
      release()
      expect((await execution).processed).toBe(1)
      expect((await replayChannel(agent, "mailbox", { limit: 1 })).skipped).toBe(1)
    } finally { release(); await execution }
  })

  it.each(["pending", "running"] as const)("recovers only an unstarted inline %s reservation after its process and lease are lost", async status => {
    const invocations = memoryInvocations()
    const { agent, run } = labeller({ invocations })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
    vi.useFakeTimers()
    try {
      const journal = await bindAgentInvocations(invocations, { ...runtime, run: { runId: channelMessageRunId("mailbox", "m1"), annotations: { [pendingAgentInvocationAnnotation]: true } } }, { recoverPending: true })
      expect(journal?.claimStatus).toBe("owned")
      if (status === "running") await journal?.running()
      await journal?.handoffClaim()
      expect(await replayChannel(agent, "mailbox", { limit: 1, runtime })).toMatchObject({ failed: status === "pending" ? 1 : 0, processed: 0, skipped: status === "pending" ? 0 : 1 })
      await vi.advanceTimersByTimeAsync(30_001)
      expect((await replayChannel(agent, "mailbox", { limit: 1, runtime })).processed).toBe(status === "pending" ? 1 : 0)
      if (status === "pending") expect(run).toHaveBeenCalledOnce()
      else expect(run).not.toHaveBeenCalled()
      expect((await replayChannel(agent, "mailbox", { limit: 1, runtime })).skipped).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it("claims before an asynchronous trigger write and retries failed trigger preparation", async () => {
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
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, invocations, runtime: false })
    const first = replayChannel(agent, "mailbox", { limit: 1 })
    try {
      await Promise.race([running, first])
      expect(await replayChannel(agent, "mailbox", { limit: 1 })).toMatchObject({ failed: 1, processed: 0, skipped: 0 })
      expect(invoke).toHaveBeenCalledOnce()
      release()
      expect((await first).failed).toBe(1)
      expect(run).not.toHaveBeenCalled()
      fail = false
      expect((await replayChannel(agent, "mailbox", { limit: 1 })).processed).toBe(1)
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
    expect(forced.items[0]?.id).toMatch(new RegExp(`^${channelMessageRunId("mailbox", "m1")}:`))
    expect(label).toHaveBeenCalledWith("m1", "label:Invoice")
  })

  it("records message writes in a dry run and keeps live replay available", async () => {
    const invocations = memoryInvocations()
    const { agent, label, run } = labeller({ invocations })

    const dryRun = await replayChannel(agent, "mailbox", { dryRun: true, limit: 2 })
    expect(dryRun).toMatchObject({ processed: 2 })
    expect(dryRun.items[0]?.id).toBe(channelMessageRunId("mailbox", "m1", { dryRun: true }))
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

    await expect(replayChannel(agent, "mailbox", { query: { folder: "spam" } })).rejects.toMatchObject({ code: "AGENT_R0935" })
    await expect(replayChannel(agent, "mailbox", { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "AGENT_R0936" })
    await expect(replayChannel(agent, "unknown")).rejects.toMatchObject({ code: "AGENT_R0931" })
    await expect(replayChannel(agent, "mailbox", { limit: 0 })).rejects.toMatchObject({ code: "AGENT_R0934" })
    expect(run).not.toHaveBeenCalled()
  })

  it("requires Agent Invocations for a live replay without force", async () => {
    const { agent } = labeller()
    await expect(replayChannel(agent, "mailbox")).rejects.toMatchObject({ code: "AGENT_R0932" })
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
