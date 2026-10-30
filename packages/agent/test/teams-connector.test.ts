import { beforeEach, describe, expect, it, vi } from "vitest"

interface TeamsThread { conversationId: string, serviceUrl: string }

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

// teams.connector() loads the optional @vite-hub/kv through this helper.
vi.mock("../src/internal/optional-kv.ts", () => ({ importOptionalKV: async () => kvModule }))

function encode(thread: TeamsThread): string {
  return `teams:${Buffer.from(thread.conversationId).toString("base64url")}:${Buffer.from(thread.serviceUrl).toString("base64url")}`
}

function decode(threadId: string): TeamsThread {
  const [, conversationId = "", serviceUrl = ""] = threadId.split(":")
  return { conversationId: Buffer.from(conversationId, "base64url").toString(), serviceUrl: Buffer.from(serviceUrl, "base64url").toString() }
}

function createAdapter() {
  let next = 100
  return {
    decodeThreadId: vi.fn(decode),
    encodeThreadId: vi.fn(encode),
    openDM: vi.fn(async (userId: string) => encode({ conversationId: `a:${userId}`, serviceUrl: "https://smba.example" })),
    // The Teams adapter before chat 4.42 returns the channel ID instead of the root thread ID.
    postChannelMessage: vi.fn(async (channelId: string) => ({ id: String(next++), raw: {}, threadId: channelId })),
    postMessage: vi.fn(async (threadId: string) => ({ id: String(next++), raw: {}, threadId })),
    editMessage: vi.fn(async (threadId: string, messageId: string) => ({ id: messageId, raw: {}, threadId })),
    deleteMessage: vi.fn(async (_threadId: string, _messageId: string) => {}),
  }
}

const channel = encode({ conversationId: "19:general@thread.tacv2", serviceUrl: "https://smba.example" })

beforeEach(() => {
  store.clear()
})

async function setup() {
  const adapter = createAdapter()
  const { teams } = await import("../src/channels.ts")
  // SAFETY: The fake implements the Teams adapter methods that the connector calls.
  return { adapter, connector: teams.connector({ adapter: adapter as never }) }
}

describe("teams.connector()", () => {
  it("posts to a thread and opens direct messages for user recipients", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("Hello", { recipient: channel })).resolves.toEqual({ id: "100" })
    await expect(connector.send("Hi", { recipient: "user:29:abc" })).resolves.toEqual({ id: "101" })
    expect(adapter.openDM).toHaveBeenCalledWith("29:abc")
    expect(adapter.postMessage).toHaveBeenLastCalledWith(encode({ conversationId: "a:29:abc", serviceUrl: "https://smba.example" }), { markdown: "Hi" })
  })

  it("returns the stored receipt for a repeated idempotency key", async () => {
    const { adapter, connector } = await setup()
    const results = await Promise.all([
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
    ])
    expect(results).toEqual([{ id: "100" }, { id: "100" }])
    expect(adapter.postMessage).toHaveBeenCalledOnce()
  })

  it("creates one root per thread key and replies under it", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:1", root: "**Ticket 1**" }
    const [first, second] = await Promise.all([
      connector.send("First", { recipient: channel, thread, idempotencyKey: "m1" }),
      connector.send("Second", { recipient: channel, thread, idempotencyKey: "m2" }),
    ])
    await expect(connector.send("First", { recipient: channel, thread, idempotencyKey: "m1" })).resolves.toEqual(first)
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postChannelMessage).toHaveBeenCalledWith(channel, { markdown: "**Ticket 1**" })
    const rootThread = encode({ conversationId: "19:general@thread.tacv2;messageid=100", serviceUrl: "https://smba.example" })
    expect(adapter.postMessage.mock.calls).toEqual([[rootThread, { markdown: "First" }], [rootThread, { markdown: "Second" }]])
    expect([first, second]).toEqual([{ id: "101" }, { id: "102" }])
  })

  it("uses the first text as the root when the thread has no root text", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("Opening", { recipient: channel, thread: { key: "topic" } })).resolves.toEqual({ id: "100" })
    await expect(connector.send("Follow-up", { recipient: channel, thread: { key: "topic" } })).resolves.toEqual({ id: "101" })
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledOnce()
  })

  it("edits the stored message in a channel thread when update is set", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:2", root: "**Ticket 2**" }
    const first = await connector.send("Draft", { recipient: channel, thread, idempotencyKey: "card", update: true })
    await expect(connector.send("Draft", { recipient: channel, thread, idempotencyKey: "card" })).resolves.toEqual(first)
    await expect(connector.send("Draft + reply", { recipient: channel, thread, idempotencyKey: "card", update: true })).resolves.toEqual(first)
    const rootThread = encode({ conversationId: "19:general@thread.tacv2;messageid=100", serviceUrl: "https://smba.example" })
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.editMessage.mock.calls).toEqual([[rootThread, first.id, { markdown: "Draft + reply" }]])
  })

  it("edits a root message that was posted from the first text", async () => {
    const { adapter, connector } = await setup()
    const first = await connector.send("Status: running", { recipient: channel, thread: { key: "job" }, idempotencyKey: "status" })
    await connector.send("Status: done", { recipient: channel, thread: { key: "job" }, idempotencyKey: "status", update: true })
    const rootThread = encode({ conversationId: "19:general@thread.tacv2;messageid=100", serviceUrl: "https://smba.example" })
    expect(first).toEqual({ id: "100" })
    expect(adapter.postMessage).not.toHaveBeenCalled()
    expect(adapter.editMessage.mock.calls).toEqual([[rootThread, "100", { markdown: "Status: done" }]])
  })

  it("edits the stored message for a direct message or a thread ID", async () => {
    const { adapter, connector } = await setup()
    const dm = encode({ conversationId: "a:29:abc", serviceUrl: "https://smba.example" })
    const first = await connector.send("one", { recipient: "user:29:abc", idempotencyKey: "dm", update: true })
    await expect(connector.send("two", { recipient: "user:29:abc", idempotencyKey: "dm", update: true })).resolves.toEqual(first)
    const second = await connector.send("three", { recipient: channel, idempotencyKey: "channel", update: true })
    await connector.send("four", { recipient: channel, idempotencyKey: "channel", update: true })
    expect(adapter.postMessage.mock.calls).toEqual([[dm, { markdown: "one" }], [channel, { markdown: "three" }]])
    expect(adapter.editMessage.mock.calls).toEqual([[dm, first.id, { markdown: "two" }], [channel, second.id, { markdown: "four" }]])
  })

  it("posts without an idempotency key even when update is set", async () => {
    const { adapter, connector } = await setup()
    await connector.send("a", { recipient: channel, update: true })
    await connector.send("b", { recipient: channel, update: true })
    expect(adapter.postMessage).toHaveBeenCalledTimes(2)
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("deletes the replaced message in a channel thread through the root thread ID", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:3", root: "**Ticket 3**" }
    const drafting = await connector.send("Drafting a suggested reply", { recipient: channel, thread, idempotencyKey: "drafting" })
    const options = { recipient: channel, thread, idempotencyKey: "suggestion", replace: "drafting" }
    const suggestion = await connector.send("Suggested reply", options)
    await expect(connector.send("Suggested reply", options)).resolves.toEqual(suggestion)
    const rootThread = encode({ conversationId: "19:general@thread.tacv2;messageid=100", serviceUrl: "https://smba.example" })
    expect([drafting, suggestion]).toEqual([{ id: "101" }, { id: "102" }])
    expect(adapter.deleteMessage.mock.calls).toEqual([[rootThread, "101"]])
    expect([...store.keys()].filter(key => key.includes(":messages:"))).toHaveLength(1)
  })

  it("deletes the replaced message without a thread and does nothing without a stored receipt", async () => {
    const { adapter, connector } = await setup()
    await connector.send("Working", { recipient: channel, idempotencyKey: "working" })
    await expect(connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })).resolves.toEqual({ id: "101" })
    await expect(connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })).resolves.toEqual({ id: "101" })
    await connector.send("Other", { recipient: channel, replace: "missing" })
    expect(adapter.deleteMessage.mock.calls).toEqual([[channel, "100"]])
    expect(store.size).toBe(1)
  })

  it("keeps the replaced receipt when the delete fails and treats a missing Teams message as deleted", async () => {
    const { adapter, connector } = await setup()
    await connector.send("Working", { recipient: channel, idempotencyKey: "working" })
    adapter.deleteMessage.mockRejectedValueOnce(new Error("Teams is unavailable"))
    await expect(connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })).rejects.toThrow("Teams is unavailable")
    expect(store.size).toBe(2)
    adapter.deleteMessage.mockRejectedValueOnce(Object.assign(new Error("Resource not found"), { originalError: { innerHttpError: { statusCode: 404 } } }))
    await expect(connector.send("Done", { recipient: channel, idempotencyKey: "done", replace: "working" })).resolves.toEqual({ id: "101" })
    expect(adapter.postMessage).toHaveBeenCalledTimes(2)
    expect(adapter.deleteMessage).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(1)
  })

  it("rejects replace with the idempotency key of the same send", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("x", { recipient: channel, idempotencyKey: "same", replace: "same" })).rejects.toThrow(TypeError)
    expect(adapter.postMessage).not.toHaveBeenCalled()
  })

  it("rejects a thread for a recipient that is not a channel", async () => {
    const { connector } = await setup()
    const reply = encode({ conversationId: "19:general@thread.tacv2;messageid=5", serviceUrl: "https://smba.example" })
    await expect(connector.send("x", { recipient: reply, thread: { key: "k" } })).rejects.toThrow("channel recipient without a message ID")
    await expect(connector.send("x", { recipient: "user:1", thread: { key: "k" } })).rejects.toThrow("channel recipient without a message ID")
    // SAFETY: The test checks the runtime guard for an untyped caller.
    await expect(connector.send("x", { recipient: "" } as never)).rejects.toThrow("requires a recipient")
  })

  it("builds the adapter from Server Env when options are omitted", async () => {
    vi.resetModules()
    const createTeamsAdapter = vi.fn(() => createAdapter())
    vi.doMock("@chat-adapter/teams", () => ({ createTeamsAdapter }))
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ teams: { appId: "app-id", appPassword: "secret", appTenantId: "tenant" } }) }))
    try {
      const { teams } = await import("../src/channels.ts")
      const teamsConnector = teams.connector({ adapter: { userName: "Bot" } })
      await teamsConnector.send("a", { recipient: channel })
      await teamsConnector.send("b", { recipient: channel })
      expect(createTeamsAdapter).toHaveBeenCalledOnce()
      expect(createTeamsAdapter).toHaveBeenCalledWith({ appId: "app-id", appPassword: "secret", appTenantId: "tenant", userName: "Bot" })
    }
    finally {
      vi.doUnmock("@chat-adapter/teams")
      vi.doUnmock("#vitehub/env/server")
      vi.resetModules()
    }
  })
})
