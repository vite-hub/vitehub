import { afterEach, describe, expect, it, vi } from "vitest"

import { Chat } from "chat"

function createState() {
  return {
    acquireLock: vi.fn(),
    appendToList: vi.fn(),
    connect: vi.fn(),
    delete: vi.fn(),
    dequeue: vi.fn(),
    disconnect: vi.fn(),
    enqueue: vi.fn(),
    extendLock: vi.fn(),
    forceReleaseLock: vi.fn(),
    get: vi.fn(),
    getList: vi.fn(),
    isSubscribed: vi.fn(),
    queueDepth: vi.fn(),
    releaseLock: vi.fn(),
    set: vi.fn(),
    setIfNotExists: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }
}

function createContext(overrides: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  return {
    memo: vi.fn((key: string, create: () => unknown) => {
      if (!values.has(key)) values.set(key, create())
      return values.get(key)
    }),
    runtime: "unknown",
    runtimeConfig: { token: "secret" },
    waitUntil: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("defineChat", () => {
  it("resolves static and request-scoped adapters and state", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const adapter = {}
    const state = createState()
    const adapterFactory = vi.fn(() => adapter)
    const stateResolver = { resolve: vi.fn(() => state) }
    const context = createContext()

    const definition = defineChat({
      adapters: { telegram: adapterFactory as never },
      state: stateResolver as never,
      userName: "Quiver Chat",
    })

    const bot = await resolveChat(definition, context as never)

    expect(bot).toBeInstanceOf(Chat)
    expect(adapterFactory).toHaveBeenCalledWith(context)
    expect(stateResolver.resolve).toHaveBeenCalledWith(context)
  })

  it("uses an inferred name when userName is omitted", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const definition = defineChat({
      adapters: {},
      state: createState() as never,
    })

    const bot = await resolveChat(definition, createContext() as never, { inferredName: "bot" })

    expect(bot).toBeInstanceOf(Chat)
  })

  it("throws clearly when a definition has no explicit or inferred userName", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const definition = defineChat({
      adapters: {},
      state: createState() as never,
    })

    await expect(resolveChat(definition, createContext() as never)).rejects.toThrow("Missing chat userName")
  })

  it("memoizes resolved definitions per request", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const context = createContext()
    const definition = defineChat({
      adapters: {},
      state: createState() as never,
      userName: "Quiver Chat",
    })

    const first = await resolveChat(definition, context as never)
    const second = await resolveChat(definition, context as never)

    expect(first).toBe(second)
    expect(context.memo).toHaveBeenCalledTimes(2)
  })

  it("runs hook sugar before setup and passes object-style args", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const setup = vi.fn()
    const onDirectMessage = vi.fn()
    const context = createContext()
    const definition = defineChat({
      adapters: {},
      hooks: { onDirectMessage },
      setup,
      state: createState() as never,
      userName: "Quiver Chat",
    })

    const bot = await resolveChat(definition, context as never)
    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({ id: "thread" } as never, { text: "hello" } as never, { id: "channel" } as never, { skipped: [] } as never)

    expect(directMessageSpy.mock.invocationCallOrder[0]).toBeLessThan(setup.mock.invocationCallOrder[0]!)
    expect(onDirectMessage).toHaveBeenCalledWith({
      bot,
      channel: { id: "channel" },
      context: { skipped: [] },
      message: { text: "hello" },
      runtimeConfig: context.runtimeConfig,
      thread: { id: "thread" },
    })
  })

  it("wraps devtools thread streams so tool parts are reported automatically", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const statuses: string[] = []
    const posted: unknown[] = []
    const onDirectMessage = vi.fn(async ({ thread }) => {
      await thread.post((async function* () {
        yield { id: "call-1", toolName: "read_file", type: "tool-input-start" }
        yield { input: { path: "README.md" }, toolCallId: "call-1", toolName: "read_file", type: "tool-call" }
        yield { input: { path: "README.md" }, output: "contents", toolCallId: "call-1", toolName: "read_file", type: "tool-result" }
        yield { id: "text-1", text: "Done", type: "text-delta" }
      })())
    })
    const context = createContext()
    const definition = defineChat({
      adapters: {},
      hooks: { onDirectMessage },
      state: createState() as never,
      userName: "Quiver Chat",
    })

    await resolveChat(definition, context as never)
    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({
      adapter: { name: "devtools" },
      id: "thread",
      post: async (message: AsyncIterable<unknown>) => {
        posted.push(message)
        for await (const _part of message) {}
      },
      startTyping: async (status: string) => {
        statuses.push(status)
      },
    } as never, { text: "hello" } as never, { id: "channel" } as never)

    expect(posted).toHaveLength(1)
    expect(statuses).toHaveLength(3)
    expect(statuses.map(status => JSON.parse(status))).toEqual([
      expect.objectContaining({ id: "call-1", name: "read_file", status: "running" }),
      expect.objectContaining({ id: "call-1", input: { path: "README.md" }, name: "read_file", status: "running" }),
      expect.objectContaining({ id: "call-1", name: "read_file", output: "contents", status: "completed" }),
    ])
  })

  it("does not report tool status for plain async text streams", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const statuses: string[] = []
    const onDirectMessage = vi.fn(async ({ thread }) => {
      await thread.post((async function* () {
        yield "hello"
        yield " world"
      })())
    })

    await resolveChat(defineChat({
      adapters: {},
      hooks: { onDirectMessage },
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({
      adapter: { name: "devtools" },
      id: "thread",
      post: async (message: AsyncIterable<unknown>) => {
        for await (const _part of message) {}
      },
      startTyping: async (status: string) => {
        statuses.push(status)
      },
    } as never, { text: "hello" } as never, { id: "channel" } as never)

    expect(statuses).toEqual([])
  })

  it("registers the supported Chat SDK hook sugar methods", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const spies = [
      vi.spyOn(Chat.prototype, "onNewMention"),
      vi.spyOn(Chat.prototype, "onSubscribedMessage"),
      vi.spyOn(Chat.prototype, "onNewMessage"),
      vi.spyOn(Chat.prototype, "onReaction"),
      vi.spyOn(Chat.prototype, "onAction"),
      vi.spyOn(Chat.prototype, "onModalSubmit"),
    ]

    await resolveChat(defineChat({
      adapters: {},
      hooks: {
        onAction: { approve: vi.fn() },
        onModalSubmit: { feedback: vi.fn() },
        onNewMention: vi.fn(),
        onNewMessage: { handler: vi.fn(), pattern: /^!help/ },
        onReaction: { thumbs_up: vi.fn() },
        onSubscribedMessage: vi.fn(),
      },
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext() as never)

    for (const spy of spies) {
      expect(spy).toHaveBeenCalled()
    }
  })

  it("preserves lifecycle hooks on chat definitions", async () => {
    const { defineChat } = await import("../src/index.ts")
    const lifecycleHooks = { request: vi.fn() }
    const definition = defineChat({
      adapters: {},
      lifecycleHooks,
      state: createState() as never,
      userName: "Quiver Chat",
    })

    expect(definition).toMatchObject({ lifecycleHooks })
  })

  it("returns raw Chat SDK instances unchanged", async () => {
    const { resolveChat } = await import("../src/index.ts")
    const bot = new Chat({
      adapters: {},
      state: createState() as never,
      userName: "Quiver Chat",
    })

    expect(await resolveChat(bot as never, createContext() as never)).toBe(bot)
  })
})

describe("runtime context", () => {
  it("memoizes values per context", async () => {
    const { createChatRuntimeContext } = await import("../src/runtime/context.ts")
    const context = createChatRuntimeContext({ runtime: "unknown" })
    const create = vi.fn(() => ({ value: "created" }))

    const first = context.memo("bot", create)
    const second = context.memo("bot", create)

    expect(first).toBe(second)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
