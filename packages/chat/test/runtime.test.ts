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

  it("uses only the internal adapter and memory state for DevTools bridge resolution", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const adapterFactory = vi.fn(() => {
      throw new Error("real adapter should not resolve")
    })
    const stateResolver = { resolve: vi.fn(() => {
      throw new Error("real state should not resolve")
    }) }

    await expect(resolveChat(defineChat({
      adapters: adapterFactory as never,
      state: stateResolver as never,
      userName: "ViteHub Chat",
    }), createContext({ devtools: { bridge: true }, platform: "devtools" }) as never)).resolves.toBeInstanceOf(Chat)

    expect(adapterFactory).not.toHaveBeenCalled()
    expect(stateResolver.resolve).not.toHaveBeenCalled()
  })

  it("keeps regular devtools platform requests on configured adapters and state", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const adapter = {}
    const state = createState()
    const adapterFactory = vi.fn(() => adapter)
    const stateResolver = { resolve: vi.fn(() => state) }
    const context = createContext({ platform: "devtools" })

    await expect(resolveChat(defineChat({
      adapters: { devtools: adapterFactory as never },
      state: stateResolver as never,
      userName: "ViteHub Chat",
    }), context as never)).resolves.toBeInstanceOf(Chat)

    expect(adapterFactory).toHaveBeenCalledWith(context)
    expect(stateResolver.resolve).toHaveBeenCalledWith(context)
  })

  it("sends DevTools messages and records fallback streaming edits", async () => {
    const { clearChatDevtoolsTranscript, getChatDevtoolsTranscript, submitChatDevtoolsMessage } = await import("../src/integrations/devtools.ts")
    clearChatDevtoolsTranscript("runtime-test")
    const state = createState()
    state.setIfNotExists.mockResolvedValue(true)
    state.acquireLock.mockResolvedValue({
      expiresAt: Date.now() + 1_000,
      threadId: "devtools:runtime-test",
      token: "lock",
    })
    state.isSubscribed.mockResolvedValue(false)
    const tasks: Promise<unknown>[] = []
    const bot = new Chat({
      adapters: {},
      fallbackStreamingPlaceholderText: "Thinking...",
      state: state as never,
      streamingUpdateIntervalMs: 1,
      userName: "ViteHub Chat",
    })
    bot.onDirectMessage(async (thread) => {
      await thread.startTyping()
      async function* stream() {
        await new Promise(resolve => setTimeout(resolve, 25))
        yield "Hello "
        yield "from DevTools"
      }

      await thread.post(stream())
    })

    await submitChatDevtoolsMessage(bot, "runtime-test", "Ping", task => tasks.push(task))
    await vi.waitFor(() => {
      expect(getChatDevtoolsTranscript("runtime-test")).toMatchObject([
        { author: "user", text: "Ping" },
        { author: "assistant", text: "Thinking..." },
      ])
    })
    await Promise.allSettled(tasks)

    const messages = getChatDevtoolsTranscript("runtime-test")
    expect(messages).toMatchObject([
      { author: "user", text: "Ping" },
      { author: "assistant", text: "Hello from DevTools" },
    ])
  })

  it("records ordered DevTools tool activity on the pending assistant message", async () => {
    const { clearChatDevtoolsTranscript, getChatDevtoolsTranscript, submitChatDevtoolsMessage } = await import("../src/integrations/devtools.ts")
    clearChatDevtoolsTranscript("runtime-test")
    const state = createState()
    state.setIfNotExists.mockResolvedValue(true)
    state.acquireLock.mockResolvedValue({
      expiresAt: Date.now() + 1_000,
      threadId: "devtools:runtime-test",
      token: "lock",
    })
    state.isSubscribed.mockResolvedValue(false)
    const tasks: Promise<unknown>[] = []
    const bot = new Chat({
      adapters: {},
      fallbackStreamingPlaceholderText: "Thinking...",
      state: state as never,
      streamingUpdateIntervalMs: 1,
      userName: "ViteHub Chat",
    })
    bot.onDirectMessage(async (thread) => {
      await thread.startTyping(JSON.stringify({
        id: "tool-1",
        input: { command: "ls" },
        name: "shell",
        output: "AGENTS.md",
        status: "completed",
        text: "Ran shell: ls",
        type: "vitehub.chat.devtools.tool",
      }))
      await thread.startTyping(JSON.stringify({
        id: "tool-2",
        input: { command: "cat AGENTS.md" },
        name: "shell",
        output: "Instructions",
        status: "completed",
        text: "Ran shell: cat AGENTS.md",
        type: "vitehub.chat.devtools.tool",
      }))
      await thread.post("Done")
    })

    await submitChatDevtoolsMessage(bot, "runtime-test", "Ping", task => tasks.push(task))
    await Promise.allSettled(tasks)

    const messages = getChatDevtoolsTranscript("runtime-test")
    expect(messages).toMatchObject([
      { author: "user", text: "Ping" },
      {
        author: "assistant",
        text: "Done",
        tools: [
          { input: { command: "ls" }, name: "shell", output: "AGENTS.md", text: "Ran shell: ls" },
          { input: { command: "cat AGENTS.md" }, name: "shell", output: "Instructions", text: "Ran shell: cat AGENTS.md" },
        ],
      },
    ])
  })

  it("keeps late DevTools tool activity on the same assistant reply", async () => {
    const { clearChatDevtoolsTranscript, createChatDevtoolsAdapter, getChatDevtoolsTranscript } = await import("../src/integrations/devtools.ts")
    clearChatDevtoolsTranscript("runtime-test")
    const adapter = createChatDevtoolsAdapter("ViteHub Chat", "Thinking...")
    const threadId = "devtools:runtime-test"
    await adapter.startTyping(threadId)
    await adapter.postMessage(threadId, "Done")
    await adapter.startTyping(threadId, JSON.stringify({
      id: "tool-1",
      input: { command: "ls" },
      name: "shell",
      output: "AGENTS.md",
      status: "completed",
      text: "Ran shell: ls",
      type: "vitehub.chat.devtools.tool",
    }))

    const messages = getChatDevtoolsTranscript("runtime-test")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      author: "assistant",
      text: "Done",
      tools: [
        { input: { command: "ls" }, name: "shell", output: "AGENTS.md", text: "Ran shell: ls" },
      ],
    })
  })

  it("reports DevTools tool steps with command labels and truncated string output", async () => {
    const { clearChatDevtoolsTranscript, createChatDevtoolsAdapter, getChatDevtoolsTranscript } = await import("../src/integrations/devtools.ts")
    const { reportChatDevtoolsToolStep } = await import("../src/devtools.ts")
    clearChatDevtoolsTranscript("runtime-test")
    const adapter = createChatDevtoolsAdapter("ViteHub Chat", "Thinking...")
    const threadId = "devtools:runtime-test"
    await adapter.startTyping(threadId)
    await reportChatDevtoolsToolStep({
      startTyping: async text => await adapter.startTyping(threadId, text),
    }, {
      toolResults: [{
        input: { command: "ls -al" },
        output: "abcdef",
        toolCallId: "tool-1",
        toolName: "shell",
      }],
    }, {
      outputPreviewLength: 4,
    })

    expect(getChatDevtoolsTranscript("runtime-test")).toMatchObject([
      {
        author: "assistant",
        text: "Thinking...",
        tools: [
          { input: { command: "ls -al" }, name: "shell", output: "a...", text: "ls -al" },
        ],
      },
    ])
  })

  it("posts a chat stream and only emits fallback when no text is streamed", async () => {
    const { postChatStream } = await import("../src/index.ts")
    const posted: unknown[] = []
    const thread = {
      post: vi.fn(async (message: string | AsyncIterable<unknown>) => {
        posted.push(message)
        if (typeof message !== "string") {
          for await (const _chunk of message) {
            // consume stream
          }
        }
      }),
    }

    const textResult = await postChatStream(thread, (async function* () {
      yield { delta: "Hello", type: "text-delta" }
    })(), { noTextFallback: "No text" })
    const emptyResult = await postChatStream(thread, (async function* () {
      yield { type: "tool-call" }
    })(), { noTextFallback: "No text" })

    expect(textResult.sawText).toBe(true)
    expect(emptyResult.sawText).toBe(false)
    expect(posted.at(-1)).toBe("No text")
    expect(thread.post).toHaveBeenCalledTimes(3)
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
