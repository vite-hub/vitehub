import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { chat, transcribe } from "../src/capabilities.ts"
import type { Adapter, ChatInstance, StateAdapter } from "chat"

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

function createMemoryState(): StateAdapter {
  const values = new Map<string, unknown>()
  const lists = new Map<string, unknown[]>()
  const subscriptions = new Set<string>()
  const queues = new Map<string, unknown[]>()
  const locks = new Map<string, { expiresAt: number, threadId: string, token: string }>()

  return {
    async acquireLock(threadId) {
      if (locks.has(threadId)) return null
      const lock = { expiresAt: Date.now() + 30_000, threadId, token: `lock-${threadId}` }
      locks.set(threadId, lock)
      return lock
    },
    async appendToList(key, value, options) {
      const list = lists.get(key) || []
      list.push(value)
      lists.set(key, typeof options?.maxLength === "number" ? list.slice(-options.maxLength) : list)
    },
    async connect() {},
    async delete(key) {
      values.delete(key)
      lists.delete(key)
    },
    async dequeue(threadId) {
      const queue = queues.get(threadId) || []
      return queue.shift() as never || null
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      const queue = queues.get(threadId) || []
      queue.push(entry)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },
    async extendLock(lock) {
      return locks.get(lock.threadId)?.token === lock.token
    },
    async forceReleaseLock(threadId) {
      locks.delete(threadId)
    },
    async get(key) {
      return values.get(key) as never || null
    },
    async getList(key) {
      return lists.get(key) as never || []
    },
    async isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },
    async queueDepth(threadId) {
      return queues.get(threadId)?.length || 0
    },
    async releaseLock(lock) {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
    },
    async set(key, value) {
      values.set(key, value)
    },
    async setIfNotExists(key, value) {
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
    async subscribe(threadId) {
      subscriptions.add(threadId)
    },
    async unsubscribe(threadId) {
      subscriptions.delete(threadId)
    },
  }
}

function createWebhookAdapter(output: { edits: unknown[], events?: string[], posts: unknown[] }): Adapter {
  let chat: ChatInstance | undefined
  const adapter = {
    addReaction: vi.fn(),
    channelIdFromThreadId: (threadId: string) => threadId,
    decodeThreadId: (threadId: string) => ({ threadId }),
    deleteMessage: vi.fn(async () => {
      output.events?.push("delete")
    }),
    editMessage: vi.fn(async (_threadId: string, id: string, message: unknown) => {
      output.events?.push("edit")
      output.edits.push(message)
      return { id, threadId: _threadId }
    }),
    fetchMessages: vi.fn(async () => ({ messages: [] })),
    fetchThread: vi.fn(async (threadId: string) => ({ id: threadId, metadata: {} })),
    handleWebhook: vi.fn(async (request: Request) => {
      const body = await request.json().catch(() => ({})) as { audio?: boolean | "fetch", text?: string }
      await (chat as ChatInstance & { handleIncomingMessage: (adapter: Adapter, threadId: string, message: unknown) => Promise<void> }).handleIncomingMessage(adapter as unknown as Adapter, "teams:dm:maxi", {
        attachments: body.audio
          ? [body.audio === "fetch"
              ? {
                  fetchData: async () => {
                    output.events?.push("fetchData")
                    return Buffer.from("AAAA")
                  },
                  mimeType: "audio/ogg",
                  name: "voice.ogg",
                  type: "audio",
                }
              : {
                  data: Buffer.from("AAAA"),
                  mimeType: "audio/ogg",
                  name: "voice.ogg",
                  type: "audio",
                }]
          : [],
        author: { fullName: "Maxi", isBot: false, isMe: false, userId: "maxi", userName: "Maxi" },
        formatted: { children: [], type: "root" },
        id: "message-1",
        metadata: { dateSent: new Date("2026-05-28T10:00:00.000Z"), edited: false },
        raw: body,
        text: body.text || (body.audio ? "" : "hello"),
        threadId: "teams:dm:maxi",
      })
      return new Response("ok")
    }),
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance
    }),
    isDM: () => true,
    name: "teams",
    parseMessage: vi.fn(),
    postMessage: vi.fn(async (threadId: string, message: unknown) => {
      output.events?.push("post")
      output.posts.push(message)
      return { id: `posted-${output.posts.length}`, threadId }
    }),
    removeReaction: vi.fn(),
  }
  return adapter as unknown as Adapter
}

describe("agent Nitro chat webhooks", () => {
  it("generates and installs the agent chat webhook route automatically", async () => {
    const root = await createTempRoot("vitehub-agent-chat-webhook-route-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default defineAgent({ capabilities: [chat({ adapters: {}, state: {} })], run: () => 'ok' })", "utf8")

    const module = (await import("../src/nitro/module.ts")).default
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        agent: {},
        alias: {},
        buildDir,
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await module.setup(nitro as never)

    const chatWebhookRouteFile = join(root, buildDir, ".vitehub", "nitro-runtime", "agent", "chat-webhook-handler.ts")
    await expect(readFile(chatWebhookRouteFile, "utf8")).resolves.toContain("defineAgentChatWebhookRegistryHandler(agentRegistry)")
    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        handler: chatWebhookRouteFile,
        method: "POST",
        route: "/api/agents/:agent/chat/:platform",
      }),
    ]))
    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "/agents/:agent",
      }),
    ]))
  })

  it("resolves inline chat adapter maps at request time and dispatches to chat.message", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], posts: unknown[] } = { edits: [], posts: [] }
    const seen: string[] = []
    const onDirectMessage = vi.fn()
    const adapter = createWebhookAdapter(output)
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [chat({
          adapters: {
            teams: () => adapter,
          },
          fallbackStreamingPlaceholderText: "Working...",
          hooks: { onDirectMessage },
          state: () => createMemoryState(),
        })],
        run(context) {
          seen.push(context.messages.map(message => message.parts
            .filter((part): part is { text: string, type: "text" } => part.type === "text")
            .map(part => part.text)
            .join("")).join("\n"))
          return "agent answer"
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ text: "hello from Teams" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(onDirectMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: { text: "hello from Teams" },
      platform: "teams",
    }))
    expect(seen).toEqual(["hello from Teams"])
    expect(output.posts).toEqual(["Working..."])
    expect(output.edits).toEqual(["agent answer"])
  })

  it("deletes chat placeholders when streamed results have no text", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], events: string[], posts: unknown[] } = { edits: [], events: [], posts: [] }
    const adapter = createWebhookAdapter(output)
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [chat({
          adapters: {
            teams: () => adapter,
          },
          fallbackStreamingPlaceholderText: "Working...",
          state: () => createMemoryState(),
        })],
        run() {
          return (async function* () {
            yield { type: "finish" }
          })()
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ text: "hello from Teams" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(output.posts).toEqual(["Working..."])
    expect(output.edits).toEqual([])
    expect(output.events).toEqual(["post", "delete"])
  })

  it("drops empty chat history messages before dispatching to the agent", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], posts: unknown[] } = { edits: [], posts: [] }
    const seen: string[][] = []
    const adapter = createWebhookAdapter(output)
    const fetchMessages = (adapter as unknown as { fetchMessages: ReturnType<typeof vi.fn> }).fetchMessages
    fetchMessages.mockResolvedValueOnce({
      messages: [
        {
          attachments: [],
          author: { isBot: true, isMe: true, userId: "bot", userName: "Bot" },
          formatted: { children: [], type: "root" },
          id: "deleted-placeholder",
          metadata: { dateSent: new Date("2026-05-28T09:59:00.000Z"), edited: false },
          text: "",
          threadId: "teams:dm:maxi",
        },
        {
          attachments: [],
          author: { isBot: false, isMe: false, userId: "maxi", userName: "Maxi" },
          formatted: { children: [], type: "root" },
          id: "history-message",
          metadata: { dateSent: new Date("2026-05-28T10:00:00.000Z"), edited: false },
          text: "previous message",
          threadId: "teams:dm:maxi",
        },
      ],
    })
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [chat({
          adapters: {
            teams: () => adapter,
          },
          history: { maxMessages: 50, source: "thread" },
          state: () => createMemoryState(),
        })],
        run(context) {
          seen.push(context.messages.map(message => message.parts
            .filter((part): part is { text: string, type: "text" } => part.type === "text")
            .map(part => part.text)
            .join("")))
          return "agent answer"
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ text: "hello from Teams" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(seen).toEqual([["previous message", "hello from Teams"]])
    expect(output.edits).toEqual(["agent answer"])
  })

  it("uses process-local chat state when state is not configured", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], posts: unknown[] } = { edits: [], posts: [] }
    const seen: string[] = []
    const adapter = createWebhookAdapter(output)
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [chat({
          adapters: {
            teams: () => adapter,
          },
          history: "none",
        })],
        run(context) {
          seen.push(context.messages.map(message => message.parts
            .filter((part): part is { text: string, type: "text" } => part.type === "text")
            .map(part => part.text)
            .join("")).join("\n"))
          return "agent answer"
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ text: "hello from Teams" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(seen).toEqual(["hello from Teams"])
    expect(output.edits).toEqual(["agent answer"])
  })

  it("memoizes configured chat state factories per agent definition", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], posts: unknown[] } = { edits: [], posts: [] }
    const adapter = createWebhookAdapter(output)
    const threadIds: string[] = []
    const state = vi.fn((context: { chat: { agentName: string, stateKeyPrefix: string } }) => {
      expect(context.chat).toEqual({
        agentName: "support",
        stateKeyPrefix: "_vitehub_support_chat",
      })
      const memory = createMemoryState()
      return {
        ...memory,
        async acquireLock(threadId: string, ttlMs: number) {
          threadIds.push(threadId)
          return await memory.acquireLock(threadId, ttlMs)
        },
      }
    })
    const support = defineAgent({
      capabilities: [chat({
        adapters: {
          teams: () => adapter,
        },
        history: "none",
        state,
      })],
      run() {
        return "agent answer"
      },
    })
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => support,
    })

    for (const text of ["first", "second"]) {
      const response = await handler({
        context: {
          params: {
            agent: "support",
            platform: "teams",
          },
        },
        req: new Request("https://example.test/api/agents/support/chat/teams", {
          body: JSON.stringify({ text }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        waitUntil: vi.fn(),
      } as never) as Response

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
    }

    expect(state).toHaveBeenCalledTimes(1)
    expect(threadIds).toContain("_vitehub_support_chat:teams:dm:maxi")
    expect(output.edits).toEqual(["agent answer"])
  })

  it("passes configured thread history size as the adapter fetch limit", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], posts: unknown[] } = { edits: [], posts: [] }
    const adapter = createWebhookAdapter(output)
    const fetchMessages = (adapter as unknown as { fetchMessages: ReturnType<typeof vi.fn> }).fetchMessages
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [chat({
          adapters: () => ({ teams: adapter }),
          history: { maxMessages: 50, source: "thread" },
          state: () => createMemoryState(),
        })],
        run() {
          return "agent answer"
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ text: "hello from Teams" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(fetchMessages).toHaveBeenCalledWith("teams:dm:maxi", {
      direction: "backward",
      limit: 50,
    })
    expect(output.edits).toEqual(["agent answer"])
  })

  it("passes chat audio attachments to transcribe()", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatWebhookRegistryHandler } = await import("../src/nitro.ts")
    const output: { edits: unknown[], events: string[], posts: unknown[] } = { edits: [], events: [], posts: [] }
    const seenText: string[] = []
    const execute = vi.fn(async () => {
      expect(output.posts).toEqual(["Working..."])
      return "audio transcript"
    })
    const adapter = createWebhookAdapter(output)
    const handler = defineAgentChatWebhookRegistryHandler({
      support: async () => defineAgent({
        capabilities: [
          chat({
            adapters: () => ({ teams: adapter }),
            fallbackStreamingPlaceholderText: "Working...",
            state: () => createMemoryState(),
          }),
          transcribe({ execute }),
        ],
        run(context) {
          seenText.push(context.messages.at(-1)?.parts
            .filter((part): part is { text: string, type: "text" } => part.type === "text")
            .map(part => part.text)
            .join("") || "")
          return "archived"
        },
      }),
    })

    const response = await handler({
      context: {
        params: {
          agent: "support",
          platform: "teams",
        },
      },
      req: new Request("https://example.test/api/agents/support/chat/teams", {
        body: JSON.stringify({ audio: "fetch" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      waitUntil: vi.fn(),
    } as never) as Response

    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        data: Buffer.from("AAAA"),
        mediaType: "audio/ogg",
        type: "audio",
      }),
    })
    expect(output.posts).toEqual(["Working..."])
    expect(output.events).toEqual(["post", "fetchData", "edit"])
    expect(seenText).toEqual(["audio transcript"])
    expect(output.edits).toEqual(["archived"])
  })
})
