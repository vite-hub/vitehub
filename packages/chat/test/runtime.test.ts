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
  vi.doUnmock("@vitehub/agent")
  vi.resetModules()
  vi.restoreAllMocks()
})

function mockAgentPackage(overrides: {
  getAgentFromRegistry?: ReturnType<typeof vi.fn>
  streamAgent?: ReturnType<typeof vi.fn>
} = {}) {
  const getAgentFromRegistry = overrides.getAgentFromRegistry || vi.fn(async () => ({ name: "agent" }))
  const streamAgent = overrides.streamAgent || vi.fn(async () => "agent response")
  vi.doMock("@vitehub/agent", () => ({
    getAgentFromRegistry,
    streamAgent,
  }))
  return { getAgentFromRegistry, streamAgent }
}

function createMessage(id: string, text: string) {
  return {
    author: { isMe: false },
    id,
    metadata: { dateSent: new Date(`2026-01-01T00:00:0${id.at(-1) || "0"}Z`) },
    text,
  }
}

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

  it("does not memoize resolves with adapter overrides", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const context = createContext()
    const definition = defineChat({
      adapters: {},
      state: createState() as never,
      userName: "Quiver Chat",
    })

    const first = await resolveChat(definition, context as never, { adapters: { first: {} } as never })
    const second = await resolveChat(definition, context as never, { adapters: { second: {} } as never })

    expect(first).not.toBe(second)
    expect(context.memo).not.toHaveBeenCalled()
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
      workflow: undefined,
    })
  })

  it("registers top-level direct message hooks and passes workflow handles", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const workflow = {
      defer: vi.fn(),
      getRun: vi.fn(),
      name: "chat-reply",
      run: vi.fn(),
    }
    const onDirectMessage = vi.fn()

    const bot = await resolveChat(defineChat({
      adapters: {},
      onDirectMessage,
      state: createState() as never,
      userName: "Quiver Chat",
      workflow,
    }), createContext() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({ id: "thread" } as never, { text: "hello" } as never, { id: "channel" } as never)

    expect(onDirectMessage).toHaveBeenCalledWith(expect.objectContaining({
      bot,
      message: { text: "hello" },
      thread: { id: "thread" },
      workflow,
    }))
  })

  it("rejects duplicate flat and nested chat hooks", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const definition = defineChat({
      adapters: {},
      hooks: { onDirectMessage: vi.fn() },
      onDirectMessage: vi.fn(),
      state: createState() as never,
      userName: "Quiver Chat",
    })

    await expect(resolveChat(definition, createContext() as never)).rejects.toThrow("Duplicate chat hook \"onDirectMessage\"")
  })

  it("registers an agent binding as a direct message hook and posts streamed output", async () => {
    const { getAgentFromRegistry, streamAgent } = mockAgentPackage()
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const post = vi.fn()
    const context = createContext({ runtime: "nitro", platform: "slack" })

    await resolveChat(defineChat({
      adapters: {},
      agent: "triager",
      state: createState() as never,
      userName: "Quiver Chat",
    }), context as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({
      id: "thread-1",
      post,
      recentMessages: [
        createMessage("m1", "hello"),
      ],
      refresh: vi.fn(),
    } as never, createMessage("m2", "help me") as never, { id: "channel-1" } as never)

    expect(getAgentFromRegistry).toHaveBeenCalledWith("triager", expect.objectContaining({
      runtime: "nitro",
      runtimeConfig: context.runtimeConfig,
    }))
    expect(streamAgent).toHaveBeenCalledWith(
      { name: "agent" },
      expect.objectContaining({ runtime: "nitro" }),
      expect.objectContaining({
        context: { chat: expect.objectContaining({ channelId: "channel-1", messageId: "m2", source: "chat", threadId: "thread-1" }) },
        messages: [
          expect.objectContaining({ id: "m1", parts: [{ id: "text-0", text: "hello", type: "text" }], role: "user" }),
          expect.objectContaining({ id: "m2", parts: [{ id: "text-0", text: "help me", type: "text" }], role: "user" }),
        ],
      }),
    )
    expect(post).toHaveBeenCalledWith("agent response")
  })

  it("passes shared capability handles through chat-to-agent handoff", async () => {
    const { getAgentFromRegistry } = mockAgentPackage()
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const capabilities = {
      sandbox: { kind: "sandbox-session", value: { name: "runner" } },
    }

    await resolveChat(defineChat({
      adapters: {},
      agent: "triager",
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext({ capabilities, runtime: "nitro" }) as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({ id: "thread-1", post: vi.fn() } as never, createMessage("m1", "hello") as never, { id: "channel-1" } as never)

    expect(getAgentFromRegistry).toHaveBeenCalledWith("triager", expect.objectContaining({
      capabilities,
      runtime: "nitro",
    }))
  })

  it("lets advanced agent hooks prepare input and replace response sending", async () => {
    const sendResponse = vi.fn()
    const prepareInput = vi.fn(() => ({ prompt: "custom prompt" }))
    const beforeRun = vi.fn(({ input }) => ({ ...input, timeout: 1000 }))
    const afterRun = vi.fn(() => "after")
    const { streamAgent } = mockAgentPackage()
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")

    await resolveChat(defineChat({
      adapters: {},
      agent: {
        history: false,
        hooks: {
          afterRun,
          beforeRun,
          prepareInput,
          sendResponse,
        },
        name: "triager",
      },
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({ id: "thread-1", post: vi.fn() } as never, createMessage("m2", "help me") as never, { id: "channel-1" } as never)

    expect(prepareInput).toHaveBeenCalledWith(expect.objectContaining({
      history: [expect.objectContaining({ parts: [{ id: "text-0", text: "help me", type: "text" }], role: "user" })],
    }))
    expect(streamAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), { prompt: "custom prompt", timeout: 1000 })
    expect(afterRun).toHaveBeenCalledWith(expect.objectContaining({ result: "agent response" }))
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ result: "after" }))
  })

  it("lets agent error hooks handle failures", async () => {
    const error = new Error("agent failed")
    const errorHook = vi.fn()
    mockAgentPackage({ streamAgent: vi.fn(async () => { throw error }) })
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")

    await resolveChat(defineChat({
      adapters: {},
      agent: {
        hooks: { error: errorHook },
        name: "triager",
      },
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await expect(handler?.({ id: "thread-1", post: vi.fn() } as never, createMessage("m2", "help me") as never, { id: "channel-1" } as never)).resolves.toBeUndefined()
    expect(errorHook).toHaveBeenCalledWith(expect.objectContaining({ error }))
  })

  it("lets agent error hooks handle input preparation failures", async () => {
    const error = new Error("prepare failed")
    const errorHook = vi.fn()
    const prepareInput = vi.fn(() => {
      throw error
    })
    mockAgentPackage()
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")

    await resolveChat(defineChat({
      adapters: {},
      agent: {
        hooks: { error: errorHook, prepareInput },
        name: "triager",
      },
      state: createState() as never,
      userName: "Quiver Chat",
    }), createContext() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await expect(handler?.({ id: "thread-1", post: vi.fn() } as never, createMessage("m2", "help me") as never, { id: "channel-1" } as never)).resolves.toBeUndefined()
    expect(errorHook).toHaveBeenCalledWith(expect.objectContaining({ error, input: undefined }))
  })

  it("rejects duplicate direct message and agent bindings", async () => {
    mockAgentPackage()
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const definition = defineChat({
      adapters: {},
      agent: "triager",
      onDirectMessage: vi.fn(),
      state: createState() as never,
      userName: "Quiver Chat",
    })

    await expect(resolveChat(definition, createContext() as never)).rejects.toThrow("Duplicate chat hook \"onDirectMessage\"")
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
