import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => new Map<string, unknown>())

const kvModule = vi.hoisted(() => ({
  kv: {
    get: async (key: string) => [null, store.get(key) ?? null],
    set: async (key: string, value: unknown) => {
      store.set(key, value)
      return [null, undefined]
    },
    del: async (key: string) => {
      store.delete(key)
      return [null, undefined]
    },
  },
}))

// Chat connectors load the optional @vite-hub/kv through this helper.
vi.mock("../src/internal/optional-kv.ts", () => ({ importOptionalKV: async () => kvModule }))

/** A fake with the thread ID shape of @chat-adapter/slack: `slack:<channel>:<thread ts>`. Message IDs are `ts` values. */
function createAdapter() {
  let next = 100
  const ts = () => `1700000000.${next++}`
  return {
    decodeThreadId: vi.fn((threadId: string) => {
      const [, channel = "", threadTs = ""] = threadId.split(":")
      return { channel, threadTs }
    }),
    encodeThreadId: vi.fn(({ channel, threadTs }: { channel: string, threadTs: string }) => `slack:${channel}:${threadTs}`),
    openDM: vi.fn(async (userId: string) => `slack:D${userId}:`),
    postChannelMessage: vi.fn(async (channelId: string) => {
      const id = ts()
      return { id, raw: { ts: id }, threadId: `slack:${channelId.split(":")[1]}:${id}` }
    }),
    postMessage: vi.fn(async (threadId: string) => ({ id: ts(), raw: {}, threadId })),
    editMessage: vi.fn(async (threadId: string, messageId: string) => ({ id: messageId, raw: {}, threadId })),
    deleteMessage: vi.fn(async (_threadId: string, _messageId: string) => {}),
  }
}

const channel = "slack:C123"

beforeEach(() => {
  store.clear()
})

async function setup() {
  const adapter = createAdapter()
  const { slack } = await import("../src/channels.ts")
  // SAFETY: The fake implements the Slack adapter methods that the connector calls.
  return { adapter, connector: slack.connector({ adapter: adapter as never }) }
}

describe("slack.connector()", () => {
  it("posts to a channel and opens direct messages for user recipients", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("Hello", { recipient: channel })).resolves.toEqual({ id: "1700000000.100" })
    await connector.send("Hi", { recipient: "user:U1" })
    expect(adapter.openDM).toHaveBeenCalledWith("U1")
    expect(adapter.postMessage.mock.calls).toEqual([[channel, { markdown: "Hello" }], ["slack:DU1:", { markdown: "Hi" }]])
  })

  it("returns the stored receipt for a repeated idempotency key and edits it with update", async () => {
    const { adapter, connector } = await setup()
    const results = await Promise.all([
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
    ])
    await expect(connector.send("Twice", { recipient: channel, idempotencyKey: "event-1", update: true })).resolves.toEqual(results[0])
    expect(results[0]).toEqual(results[1])
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.editMessage.mock.calls).toEqual([[channel, results[0]!.id, { markdown: "Twice" }]])
    expect([...store.keys()].every(key => key.startsWith("slack:messages:"))).toBe(true)
  })

  it("replies under one root per thread key through the root ts", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:1", root: "*Ticket 1*" }
    const first = await connector.send("First", { recipient: channel, thread, idempotencyKey: "m1" })
    await connector.send("First, edited", { recipient: channel, thread, idempotencyKey: "m1", update: true })
    await connector.send("Second", { recipient: channel, thread })
    const rootThread = "slack:C123:1700000000.100"
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage.mock.calls).toEqual([[rootThread, { markdown: "First" }], [rootThread, { markdown: "Second" }]])
    expect(adapter.editMessage.mock.calls).toEqual([[rootThread, first.id, { markdown: "First, edited" }]])
  })

  it("deletes the replaced message in a thread and without a thread", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:2", root: "*Ticket 2*" }
    const drafting = await connector.send("Drafting", { recipient: channel, thread, idempotencyKey: "drafting" })
    const options = { recipient: channel, thread, idempotencyKey: "suggestion", replace: "drafting" }
    const suggestion = await connector.send("Suggestion", options)
    await expect(connector.send("Suggestion", options)).resolves.toEqual(suggestion)
    const working = await connector.send("Working", { recipient: channel, idempotencyKey: "working" })
    await connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })
    await connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })
    expect(adapter.deleteMessage.mock.calls).toEqual([["slack:C123:1700000000.100", drafting.id], [channel, working.id]])
  })

  it("treats a Slack message_not_found as deleted and rejects replacing the thread root", async () => {
    const { adapter, connector } = await setup()
    await connector.send("Working", { recipient: channel, idempotencyKey: "working" })
    adapter.deleteMessage.mockRejectedValueOnce(Object.assign(new Error("An API error occurred: message_not_found"), { code: "slack_webapi_platform_error", data: { error: "message_not_found" } }))
    await connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })
    expect(store.size).toBe(1)
    await connector.send("Opening", { recipient: channel, thread: { key: "topic" }, idempotencyKey: "opening" })
    await expect(connector.send("Reply", { recipient: channel, thread: { key: "topic" }, idempotencyKey: "reply", replace: "opening" })).rejects.toThrow("Slack replace cannot delete a channel thread root")
  })

  it("rejects a thread recipient and a connector without an adapter", async () => {
    const { connector } = await setup()
    await expect(connector.send("x", { recipient: "slack:C123:1700000000.1", thread: { key: "k" } })).rejects.toThrow("channel recipient without a message ID")
    const { slack } = await import("../src/channels.ts")
    // SAFETY: The test checks the runtime guard for an untyped caller.
    expect(() => slack.connector({} as never)).toThrow("requires an adapter")
  })
})
