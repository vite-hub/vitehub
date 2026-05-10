import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { Chat } from "chat"

import type { ChatDevtoolsStateResult } from "../src/devtools.ts"

function createState() {
  return {
    acquireLock: vi.fn(async () => ({ expiresAt: Date.now() + 1000, threadId: "thread", token: "lock" })),
    appendToList: vi.fn(),
    connect: vi.fn(),
    delete: vi.fn(),
    dequeue: vi.fn(async () => null),
    disconnect: vi.fn(),
    enqueue: vi.fn(async () => 1),
    extendLock: vi.fn(async () => true),
    forceReleaseLock: vi.fn(),
    get: vi.fn(async () => null),
    getList: vi.fn(async () => []),
    isSubscribed: vi.fn(async () => false),
    queueDepth: vi.fn(async () => 0),
    releaseLock: vi.fn(),
    set: vi.fn(),
    setIfNotExists: vi.fn(async () => true),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }
}

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  }
})

function createDevtoolsContext() {
  const stream = {
    close: vi.fn(),
    error: vi.fn(),
    id: "stream-1",
    signal: new AbortController().signal,
    write: vi.fn(),
  }
  return {
    docks: {
      register: vi.fn(),
    },
    messages: {
      add: vi.fn(),
    },
    rpc: {
      register: vi.fn(),
      streaming: {
        create: vi.fn(() => ({
          start: vi.fn(() => stream),
        })),
      },
    },
    views: {
      hostStatic: vi.fn(),
    },
    viteConfig: {
      server: {
        port: 3000,
      },
    },
    viteServer: {
      resolvedUrls: {
        local: ["http://127.0.0.1:3000/"],
      },
    },
    stream,
  }
}

async function createNitroModuleStub(chat: unknown = {}, dev = true) {
  const { existsSync } = await import("node:fs")
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-devtools-"))
  await mkdir(join(rootDir, "server"), { recursive: true })
  await writeFile(join(rootDir, "server", "chat.ts"), "export default {}", "utf8")
  vi.mocked(existsSync).mockImplementation(file => String(file).endsWith("chat.ts"))
  const hooks: Record<string, Function[]> = {}
  return {
    hooks: {
      hook(name: string, handler: Function) {
        hooks[name] ||= []
        hooks[name]?.push(handler)
      },
    },
    options: {
      alias: {} as Record<string, string>,
      buildDir: ".nitro",
      chat,
      dev,
      externals: {} as { inline?: string[] },
      handlers: [] as Array<{ handler: string, method?: string, route: string }>,
      imports: {},
      output: { serverDir: join(rootDir, ".output", "server") },
      plugins: [] as string[],
      preset: "nitro",
      rootDir,
      runtimeConfig: {} as Record<string, unknown>,
    },
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of stream) result.push(item)
  return result
}

beforeEach(() => {
  vi.stubEnv("VITEHUB_CHAT_DEVTOOLS_URL", "")
  vi.restoreAllMocks()
})

describe("Chat DevTools Vite integration", () => {
  it("registers standalone panel, RPC functions, and Nitro singleton bridge route", async () => {
    const { chatDevtoolsBridgeRoute, chatDevTools } = await import("../src/devtools.ts")
    const ctx = createDevtoolsContext()
    const nitro = { options: { dev: true, handlers: [] } }
    const plugin = chatDevTools()

    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)
    ;(plugin as { nitro: { setup: (nitro: unknown) => void } }).nitro.setup(nitro)

    expect(ctx.views.hostStatic).toHaveBeenCalledWith(
      "/__vitehub/chat-devtools/",
      expect.stringContaining("dist/devtools-client"),
    )
    expect(ctx.rpc.register).toHaveBeenCalledTimes(3)
    expect(ctx.rpc.streaming.create).toHaveBeenCalledWith("@vitehub/chat:stream", {
      replayWindow: 1024,
      closedStreamRetention: 30_000,
    })
    expect(nitro.options.handlers).toEqual([
      expect.objectContaining({
        method: "POST",
        route: chatDevtoolsBridgeRoute,
        handler: expect.stringContaining("chat-devtools-handler.ts"),
      }),
    ])
  })

  it("does not install the standalone bridge route when DevTools are disabled", async () => {
    const { chatDevTools } = await import("../src/devtools.ts")
    const nitro = { options: { dev: true, handlers: [] } }
    const plugin = chatDevTools({ devtools: false })

    ;(plugin as { nitro: { setup: (nitro: unknown) => void } }).nitro.setup(nitro)

    expect(nitro.options.handlers).toEqual([])
  })

  it("does not install the standalone bridge route outside Nitro dev mode", async () => {
    const { chatDevTools } = await import("../src/devtools.ts")
    const nitro = { options: { dev: false, handlers: [] } }
    const plugin = chatDevTools()

    ;(plugin as { nitro: { setup: (nitro: unknown) => void } }).nitro.setup(nitro)

    expect(nitro.options.handlers).toEqual([])
  })

  it("registers the local iframe panel and hosted static assets by default", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    const plugin = hubChat()

    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    expect(ctx.views.hostStatic).toHaveBeenCalledWith(
      "/__vitehub/chat-devtools/",
      expect.stringContaining("dist/devtools-client"),
    )
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      icon: "ph:chat-circle-duotone",
      id: "@vitehub/chat",
      title: "ViteHub Chat",
      type: "iframe",
      url: "/__vitehub/chat-devtools/",
    }))
    expect(ctx.docks.register.mock.calls[0]?.[0]).not.toHaveProperty("remote")
  })

  it("marks absolute URL overrides as remote iframes", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    const plugin = hubChat({ dev: { devtools: { url: "http://localhost:3300" } } })

    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      remote: true,
      url: "http://localhost:3300",
    }))
  })

  it("registers no panel or RPC functions when DevTools are disabled", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    const plugin = hubChat({ dev: { devtools: false } })

    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).not.toHaveBeenCalled()
    expect(ctx.rpc.register).not.toHaveBeenCalled()
  })

  it("RPC handlers call the Nitro bridge route", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { stream?: boolean } : {}
      if (body.stream) {
        return new Response(`${JSON.stringify({
          type: "state",
          state: {
            chats: [{ name: "default", messages: [{
              createdAt: "now",
              id: "assistant-1",
              role: "assistant",
              text: "",
              tools: [{
                id: "tool-1",
                name: "shell",
                status: "running",
                text: "ls",
                updatedAt: "now",
              }],
            }] }],
            selected: "default",
          },
        })}\n${JSON.stringify({ type: "done" })}\n`)
      }
      return new Response(JSON.stringify({
        chats: [{ name: "default", messages: [] }],
        selected: "default",
      }))
    })
    vi.stubGlobal("fetch", fetchMock)

    const plugin = hubChat()
    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    const functions = ctx.rpc.register.mock.calls.map(call => call[0])
    await functions.find(fn => fn.name === "@vitehub/chat:get-state")!.setup().handler()
    const sendResult = await functions.find(fn => fn.name === "@vitehub/chat:send")!.setup().handler({ chat: "default", text: "hello" })
    await functions.find(fn => fn.name === "@vitehub/chat:clear")!.setup().handler({ chat: "default" })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sendResult).toMatchObject({
      chats: [],
      selected: "default",
      streamId: "stream-1",
    })
    expect(ctx.stream.write).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        chats: [expect.objectContaining({
          messages: [expect.objectContaining({
            tools: [expect.objectContaining({ id: "tool-1", status: "running" })],
          })],
        })],
      }),
      type: "state",
    }))
    expect(ctx.stream.close).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:3000/__vitehub/chat/devtools"), expect.objectContaining({
      method: "POST",
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(URL), expect.objectContaining({
      body: JSON.stringify({ action: "send", chat: "default", text: "hello", stream: true }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, expect.any(URL), expect.objectContaining({
      body: JSON.stringify({ action: "clear", chat: "default" }),
    }))
  })

  it("keeps send RPC errors JSON-safe", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { stream?: boolean } : {}
      if (body.stream) {
        return new Response("boom", { status: 500 })
      }
      return new Response(JSON.stringify({
        chats: [{ name: "default", messages: [] }],
        selected: "default",
      }))
    })
    vi.stubGlobal("fetch", fetchMock)

    const plugin = hubChat()
    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    const functions = ctx.rpc.register.mock.calls.map(call => call[0])
    const send = functions.find(fn => fn.name === "@vitehub/chat:send")!
    const sendResult = await send.setup().handler({ chat: "default", text: "hello" })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(send).not.toHaveProperty("jsonSerializable")
    expect(sendResult).toMatchObject({
      chats: [],
      selected: "default",
      streamId: "stream-1",
    })
    expect(ctx.stream.write).toHaveBeenCalledWith({
      message: "Chat DevTools bridge failed with 500: boom",
      type: "error",
    })
    expect(ctx.stream.error).not.toHaveBeenCalled()
    expect(ctx.stream.close).toHaveBeenCalled()
  })

  it("falls back to non-streaming sends when RPC streaming is unavailable", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const ctx = createDevtoolsContext()
    ;(ctx.rpc as { streaming?: unknown }).streaming = undefined
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      chats: [{ name: "default", messages: [{ createdAt: "now", id: "1", role: "user", text: "hello" }] }],
      selected: "default",
    })))
    vi.stubGlobal("fetch", fetchMock)

    const plugin = hubChat()
    ;(plugin as { devtools: { setup: (ctx: unknown) => void } }).devtools.setup(ctx)

    const functions = ctx.rpc.register.mock.calls.map(call => call[0])
    const sendResult = await functions.find(fn => fn.name === "@vitehub/chat:send")!.setup().handler({ chat: "default", text: "hello" })

    expect(sendResult).toEqual({
      chats: [{ name: "default", messages: [{ createdAt: "now", id: "1", role: "user", text: "hello" }] }],
      selected: "default",
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      body: JSON.stringify({ action: "send", chat: "default", text: "hello" }),
    }))
    expect(ctx.rpc.streaming).toBeUndefined()
  })

  it("adds the bridge route from the Nitro module in dev", async () => {
    const chatNitroModule = (await import("../src/nitro/module.ts")).default
    const { chatDevtoolsBridgeRoute } = await import("../src/devtools.ts")
    const nitro = await createNitroModuleStub()

    await chatNitroModule.setup!(nitro as never)

    expect(nitro.options.handlers).toEqual(expect.arrayContaining([expect.objectContaining({
      handler: expect.stringContaining("devtools-handler.mjs"),
      method: "POST",
      route: chatDevtoolsBridgeRoute,
    })]))
    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([expect.objectContaining({
      handler: expect.stringContaining("chat-devtools-handler"),
    })]))
  })

  it("does not add the bridge route when Chat DevTools are disabled", async () => {
    const chatNitroModule = (await import("../src/nitro/module.ts")).default
    const nitro = await createNitroModuleStub({ dev: { devtools: false } })

    await chatNitroModule.setup!(nitro as never)

    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([expect.objectContaining({
      route: "/__vitehub/chat/devtools",
    })]))
  })
})

describe("Chat DevTools Nitro bridge", () => {
  function createBridgeEvent(body: unknown) {
    return {
      req: new Request("http://127.0.0.1:3000/__vitehub/chat/devtools", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    }
  }

  it("createDevtoolsAdapter records messages, edits, and tool status", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const sent = await adapter.postMessage(user.threadId, "Thinking")

    await adapter.startTyping(user.threadId, createChatDevtoolsToolStatus({
      id: "call-1",
      input: { query: "vite" },
      name: "search",
      status: "running",
      text: "search",
    }))
    await adapter.editMessage(user.threadId, sent.id, "Done")

    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        text: "Done",
        tools: [
          expect.objectContaining({
            id: "call-1",
            input: { query: "vite" },
            name: "search",
            status: "running",
          }),
        ],
      }),
    ])
  })

  it("plain string streams do not create tool entries", async () => {
    const { createDevtoolsAdapter, observeChatDevtoolsStream } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const stream = observeChatDevtoolsStream({ startTyping: status => adapter.startTyping(user.threadId, status) }, (async function* () {
      yield "hel"
      yield "lo"
    })())

    expect(await collect(stream)).toEqual(["hel", "lo"])
    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
    ])
  })

  it("AI SDK full streams create completed tool entries without consuming stream parts", async () => {
    const { createDevtoolsAdapter, observeChatDevtoolsStream } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const parts = [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "search" },
      { type: "tool-call", toolCallId: "call-1", toolName: "search", input: { query: "vite" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "search", input: { query: "vite" }, output: "result" },
    ]
    const stream = observeChatDevtoolsStream({ startTyping: status => adapter.startTyping(user.threadId, status) }, (async function* () {
      for (const part of parts) yield part
    })())

    expect(await collect(stream)).toEqual(parts)
    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        tools: [
          expect.objectContaining({
            id: "call-1",
            input: { query: "vite" },
            name: "search",
            output: "result",
            status: "completed",
          }),
        ],
      }),
    ])
    expect(user.threadId).toBe("devtools:chat:thread")
  })

  it("AI SDK step reporter records command labels and output-only shell results", async () => {
    const { createChatDevtoolsStepReporter, createDevtoolsAdapter } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const reporter = createChatDevtoolsStepReporter({
      startTyping: status => adapter.startTyping(user.threadId, status),
    })

    await reporter({
      toolCalls: [
        {
          input: { command: "rg -n vite data-sources" },
          toolCallId: "call-1",
          toolName: "shell",
        },
      ],
    })
    await reporter({
      toolResults: [
        {
          input: { command: "rg -n vite data-sources" },
          output: {
            exitCode: 0,
            stderr: "",
            stdout: "data-sources/README.md:1:vite\n",
          },
          toolCallId: "call-1",
          toolName: "shell",
        },
      ],
    })
    await adapter.postMessage(user.threadId, "Done")

    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        text: "Done",
        tools: [
          expect.objectContaining({
            id: "call-1",
            input: { command: "rg -n vite data-sources" },
            name: "shell",
            output: "data-sources/README.md:1:vite",
            status: "completed",
            text: "rg -n vite data-sources",
          }),
        ],
      }),
    ])
  })

  it("AI SDK step reporter supports name/id shaped tool events", async () => {
    const { createChatDevtoolsStepReporter, createDevtoolsAdapter } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const reporter = createChatDevtoolsStepReporter({
      startTyping: status => adapter.startTyping(user.threadId, status),
    })

    await reporter({
      toolResults: [
        {
          id: "tool-1",
          input: { path: "README.md" },
          name: "read_file",
          output: { ok: true },
        },
      ],
    })

    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        tools: [
          expect.objectContaining({
            id: "tool-1",
            name: "read_file",
            output: { ok: true },
            status: "completed",
            text: "read_file",
          }),
        ],
      }),
    ])
  })

  it("AI SDK full stream shell results are stored as output-only previews", async () => {
    const { createDevtoolsAdapter, observeChatDevtoolsStream } = await import("../src/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const user = adapter.createDevtoolsMessage("hello")
    const parts = [
      {
        input: { command: "cat data-sources/AGENTS.md" },
        output: { exitCode: 0, stderr: "", stdout: "# Agent notes\n" },
        toolCallId: "call-1",
        toolName: "shell",
        type: "tool-result",
      },
    ]

    const stream = observeChatDevtoolsStream({ startTyping: status => adapter.startTyping(user.threadId, status) }, (async function* () {
      for (const part of parts) yield part
    })())

    expect(await collect(stream)).toEqual(parts)
    expect(adapter.getDevtoolsState().chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({
        role: "assistant",
        tools: [
          expect.objectContaining({
            input: { command: "cat data-sources/AGENTS.md" },
            output: "# Agent notes",
            text: "cat data-sources/AGENTS.md",
          }),
        ],
      }),
    ])
  })

  it("singleton bridge dispatches through the registered devtools adapter", async () => {
    const { createDevtoolsAdapter } = await import("../src/devtools.ts")
    const { defineChatDevtoolsSingletonHandler } = await import("../src/nitro.ts")
    const devtools = createDevtoolsAdapter()
    const chat = new Chat({
      adapters: { devtools },
      state: createState() as never,
      userName: "Devtools Test",
    }).registerSingleton()
    const processMessage = vi.spyOn(chat, "processMessage").mockImplementation(async (adapter, threadId, messageOrFactory) => {
      const message = typeof messageOrFactory === "function" ? undefined : messageOrFactory
      await Promise.resolve()
      void adapter.postMessage(threadId, `echo: ${message?.text || ""}`)
    })
    const handler = defineChatDevtoolsSingletonHandler()

    const result = await handler(createBridgeEvent({ action: "send", text: "hello" }) as never) as ChatDevtoolsStateResult

    expect(processMessage).toHaveBeenCalledWith(devtools, "devtools:chat:thread", expect.objectContaining({ text: "hello" }), expect.any(Object))
    expect(result.chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "echo: hello" }),
    ])
  })

  it("registry bridge uses the DevTools adapter without resolving production adapters", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatDevtoolsHandler } = await import("../src/nitro.ts")
    const chat = defineChat({
      adapters: vi.fn(() => {
        throw new Error("Production adapter should not be resolved")
      }) as never,
      state: createState() as never,
      async onDirectMessage({ message, thread }) {
        await thread.post(`echo: ${message.text}`)
      },
    })
    const handler = defineChatDevtoolsHandler(chat as never)

    const result = await handler(createBridgeEvent({ action: "send", text: "hello" }) as never) as ChatDevtoolsStateResult

    expect(result.chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "echo: hello" }),
    ])
  })

  it("stores tool status updates on the assistant transcript message", async () => {
    const { createChatDevtoolsToolStatus } = await import("../src/devtools.ts")
    const { defineChatDevtoolsHandler } = await import("../src/nitro.ts")
    const chat = {
      handleIncomingMessage: vi.fn(async (adapter, threadId) => {
        await adapter.startTyping(threadId, createChatDevtoolsToolStatus({
          id: "call-1",
          input: { path: "README.md" },
          name: "read_file",
          status: "running",
          text: "read_file",
        }))
        await adapter.startTyping(threadId, createChatDevtoolsToolStatus({
          id: "call-1",
          input: { path: "README.md" },
          name: "read_file",
          output: "contents",
          status: "completed",
          text: "read_file",
        }))
        await adapter.postMessage(threadId, "Done")
      }),
      initialize: vi.fn(),
    }
    const handler = defineChatDevtoolsHandler(chat as never)

    const result = await handler(createBridgeEvent({ action: "send", text: "hello" }) as never) as ChatDevtoolsStateResult
    expect(result.chats[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "hello" }),
    ]))
    const assistant = result.chats[0]?.messages.find((message): boolean => message.role === "assistant")

    expect(assistant).toMatchObject({
      text: "Done",
      tools: [
        expect.objectContaining({
          id: "call-1",
          input: { path: "README.md" },
          name: "read_file",
          output: "contents",
          status: "completed",
        }),
      ],
    })
  })

  it("exposes previous registry bridge turns to chat handlers", async () => {
    const { defineChatDevtoolsHandler } = await import("../src/nitro.ts")
    const seenHistory: string[][] = []
    const chat = {
      handleIncomingMessage: vi.fn(async (adapter, threadId, message) => {
        const history = await adapter.fetchMessages(threadId)
        seenHistory.push(history.messages.map((item: { text: string }) => item.text))
        await adapter.postMessage(threadId, `history: ${history.messages.length}; ${message.text}`)
      }),
      initialize: vi.fn(),
    }
    const handler = defineChatDevtoolsHandler(chat as never)

    await handler(createBridgeEvent({ action: "send", text: "first" }) as never)
    await handler(createBridgeEvent({ action: "send", text: "second" }) as never)

    expect(seenHistory).toEqual([
      ["first"],
      ["first", "history: 1; first", "second"],
    ])
  })

  it("does not synthesize a selectable chat for an empty registry", async () => {
    const { defineChatDevtoolsRegistryHandler } = await import("../src/nitro.ts")
    const handler = defineChatDevtoolsRegistryHandler({})

    const result = await handler(createBridgeEvent({ action: "get-state" }) as never) as ChatDevtoolsStateResult

    expect(result).toEqual({
      chats: [],
      selected: "",
    })
    await expect(handler(createBridgeEvent({ action: "send", text: "hello" }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it("preserves previous registry bridge turns across sends", async () => {
    const { defineChatDevtoolsHandler } = await import("../src/nitro.ts")
    const chat = {
      handleIncomingMessage: vi.fn(async (adapter, threadId, message) => {
        await adapter.postMessage(threadId, `echo: ${message.text}`)
      }),
      initialize: vi.fn(),
    }
    const handler = defineChatDevtoolsHandler(chat as never)

    await handler(createBridgeEvent({ action: "send", text: "first" }) as never)
    const result = await handler(createBridgeEvent({ action: "send", text: "second" }) as never) as ChatDevtoolsStateResult

    expect(result.chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "first" }),
      expect.objectContaining({ role: "assistant", text: "echo: first" }),
      expect.objectContaining({ role: "user", text: "second" }),
      expect.objectContaining({ role: "assistant", text: "echo: second" }),
    ])
  })
})
