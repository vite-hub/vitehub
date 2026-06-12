import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Message } from "chat"
import { describe, expect, it, vi } from "vitest"

import type { Adapter, ChatInstance, StreamChunk, WebhookOptions } from "chat"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

function createTestChatAdapter(options: { deferMessageProcessing?: boolean, secret?: string } = {}) {
  let chatInstance: ChatInstance | undefined
  const adapter = {
    channelIdFromThreadId: vi.fn((threadId: string) => threadId),
    handleWebhook: vi.fn(async (request: Request, webhookOptions?: WebhookOptions) => {
      if (options.secret && request.headers.get("x-test-secret") !== options.secret) {
        return Response.json({ ok: false }, { status: 401 })
      }
      const body = await request.json().catch(() => undefined) as { message?: Record<string, unknown>, update_id?: number } | undefined
      const rawMessage = body?.message
      if (!rawMessage || !chatInstance) {
        return Response.json({ ignored: true, ok: true })
      }
      const chat = rawMessage.chat as { id?: number | string } | undefined
      const from = rawMessage.from as { id?: number | string, username?: string } | undefined
      const date = typeof rawMessage.date === "number"
        ? new Date(rawMessage.date * 1000)
        : new Date("2026-06-10T12:00:00.000Z")
      const message = new Message({
        attachments: rawMessage.audio
          ? [{
              fetchData: async () => Buffer.from([1, 2, 3]),
              fetchMetadata: { fileId: "audio-file" },
              mimeType: "audio/ogg",
              name: "voice.ogg",
              size: 3,
              type: "audio",
            }]
          : [],
        author: {
          fullName: "Maxi",
          isBot: false,
          isMe: false,
          userId: String(from?.id ?? "123"),
          userName: String(from?.username ?? "maxi"),
        },
        formatted: { children: [], type: "root" },
        id: String(rawMessage.message_id ?? "7"),
        metadata: { dateSent: date, edited: false },
        raw: body,
        text: typeof rawMessage.text === "string" ? rawMessage.text : "",
        threadId: `telegram:${String(chat?.id ?? "456")}`,
      })
      const task = chatInstance.processMessage(adapter as unknown as Adapter, message.threadId, message, webhookOptions)
      if (!options.deferMessageProcessing) {
        await task
      }
      else {
        task.catch(() => undefined)
      }
      return Response.json({ ok: true })
    }),
    initialize: vi.fn(async (chat: ChatInstance) => {
      chatInstance = chat
    }),
    isDM: vi.fn(() => true),
    editMessage: vi.fn(async (threadId: string, messageId: string, message: unknown) => ({ id: messageId, raw: { message }, threadId })),
    name: "telegram",
    postMessage: vi.fn(async (threadId: string, message: unknown) => ({ id: "sent-1", raw: { message }, threadId })),
    startTyping: vi.fn(async () => {}),
    userName: "vitehub",
  }
  return adapter as unknown as Adapter & {
    handleWebhook: ReturnType<typeof vi.fn>
    editMessage: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
    startTyping: ReturnType<typeof vi.fn>
  }
}

describe("agent Vite plugin", () => {
  it("ignores generated ViteHub files in the Vite dev watcher", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const config = plugin.config as (config: { server?: { watch?: { ignored?: string | string[] } } }) => { server?: { watch?: { ignored?: string[] } } }

    expect(config({}).server?.watch?.ignored).toEqual(["**/.vitehub/**"])
    expect(config({ server: { watch: { ignored: ["**/node_modules/**"] } } }).server?.watch?.ignored).toEqual([
      "**/node_modules/**",
      "**/.vitehub/**",
    ])
    expect(config({ server: { watch: { ignored: ["**/.vitehub/**"] } } }).server?.watch?.ignored).toEqual(["**/.vitehub/**"])
  })

  it("merges server noExternal", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()

    const hook = plugin.configEnvironment
    const result = typeof hook === "function"
      ? hook.call({} as never, "ssr", {
          consumer: "server",
          resolve: { noExternal: ["existing"] },
        } as never, {} as never)
      : undefined

    expect(result).toMatchObject({
      resolve: { noExternal: ["existing", "@vite-hub/agent"] },
    })
  })

  it("exposes hubAgent options through Vite config", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ route: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({ agent: { route: true } })
  })

  it("registers configured agent routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ route: "/api/_vitehub/agents/[agent]/chat" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: [{
          handler: ".vitehub/agent/chat-route.ts",
          route: "/api/_vitehub/agents/:agent/chat",
        }],
      },
    })
  })

  it("materializes the MCP runtime package for Vercel build output", async () => {
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ eval: false })
    const configResolved = plugin.configResolved as (config: { agent?: unknown, command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root: "/app" })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [{ includePeerDependencies: true, name: "@ai-sdk/mcp", optional: true }],
      rootDir: "/app",
    })
  })

  it("registers configured agent webhook routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ webhooks: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: [{
          handler: ".vitehub/agent/chat-webhook-route.ts",
          route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
        }],
      },
    })
  })

  it("installs Cloudflare chat state bindings for generated webhook routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ webhooks: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {
          build: {
            rolldownOptions: {
              external: ["existing"],
            },
          },
          nitro: {
            cloudflare: {
              wrangler: {
                migrations: [{
                  deleted_classes: ["ViteHubAgentStateDO"],
                  tag: "delete-vitehub-agent-state-do-2026-06-11",
                }],
              },
            },
          },
        } as never, { command: "build", mode: "production" })
      : undefined
    const output = result as {
      build?: unknown
      nitro?: {
        cloudflare?: {
          wrangler?: {
            durable_objects?: { bindings?: unknown[] }
            migrations?: unknown[]
          }
        }
        rollupConfig?: {
          external?: unknown
          plugins?: Array<{ name?: string }>
        }
      }
    }

    expect(output.nitro?.cloudflare?.wrangler?.durable_objects?.bindings).toContainEqual({
      class_name: "ViteHubAgentStateDO",
      name: "CHAT_STATE",
    })
    expect(output.nitro?.cloudflare?.wrangler?.migrations).toContainEqual({
      new_sqlite_classes: ["ViteHubAgentStateDO"],
      tag: "vitehub-agent-state-v1",
    })
    expect(output.nitro?.cloudflare?.wrangler?.migrations).not.toContainEqual(expect.objectContaining({
      deleted_classes: ["ViteHubAgentStateDO"],
    }))
    expect(output.nitro?.rollupConfig?.external).toEqual(["cloudflare:workers"])
    expect(output.nitro?.rollupConfig?.plugins?.some(plugin => plugin.name === "vitehub-agent-cloudflare-state-exports:ViteHubAgentStateDO")).toBe(true)
    expect(output.build).toBeUndefined()
  })

  it("keeps Cloudflare chat state opt-out when the state provider is memory", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ providers: { state: { provider: "memory" } }, webhooks: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined
    const output = result as {
      build?: unknown
      nitro?: {
        cloudflare?: unknown
        handlers?: unknown[]
        rollupConfig?: unknown
      }
    }

    expect(output.nitro?.handlers).toContainEqual({
      handler: ".vitehub/agent/chat-webhook-route.ts",
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    })
    expect(output.nitro?.cloudflare).toBeUndefined()
    expect(output.nitro?.rollupConfig).toBeUndefined()
    expect(output.build).toBeUndefined()
  })

  it("keeps chat routes and webhook routes independent", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({
      route: "/api/_vitehub/agents/[agent]/chat",
      webhooks: "/hooks/[agent]/[webhook]",
    })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: [
          {
            handler: ".vitehub/agent/chat-route.ts",
            route: "/api/_vitehub/agents/:agent/chat",
          },
          {
            handler: ".vitehub/agent/chat-webhook-route.ts",
            route: "/hooks/:agent/:webhook",
          },
        ],
      },
    })
  })

  it("writes generated Nitro handlers that pass Web Requests to agent routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-routes-"))
    try {
      const plugin = hubAgent({ route: true, webhooks: true })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const chatRoute = await readFile(join(root, ".vitehub/agent/chat-route.ts"), "utf8")
      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(chatRoute).toContain("async function toRequest(event)")
      expect(chatRoute).toContain("function waitUntilFromEvent(event)")
      expect(chatRoute).toContain("function cloudflareFromEvent(event)")
      expect(chatRoute).toContain("return await handler(await toRequest(event), { cloudflare, waitUntil: waitUntilFromEvent(event) })")
      expect(webhookRoute).toContain("import { createCloudflareAgentState } from '@vite-hub/agent/cloudflare'")
      expect(webhookRoute).toContain("async function toRequest(event)")
      expect(webhookRoute).toContain("function waitUntilFromEvent(event)")
      expect(webhookRoute).toContain("function chatStateFromCloudflare(cloudflare)")
      expect(webhookRoute).toContain("waitUntil: waitUntilFromEvent(event)")
      expect(webhookRoute).toContain("state: chatStateFromCloudflare(cloudflare)")
      expect(webhookRoute).toContain("return await handler(await toRequest(event), webhook")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("publishes the Cloudflare state Durable Object subpath", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, string>
    }

    expect(pkg.exports?.["./cloudflare/state"]).toBe("./dist/cloudflare/state.js")
  })
})

describe("server helpers", () => {
  it("rejects chat route requests without messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatFetchHandler } = await import("../src/server.ts")
    const handler = defineAgentChatFetchHandler(defineAgent({ run: () => "unused" }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({}),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({
      message: "Agent chat route requires messages.",
      status: 400,
    })
    expect(response.status).toBe(400)
  })

  it("handles Chat SDK webhooks through the chat capability", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access, chat, staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const admitChat = vi.fn(({ identity }) => identity?.id === "123")
    const run = vi.fn(({ messages }) => {
      const text = messages[0]?.parts.find((part: { type?: string }) => part.type === "text") as { text?: string } | undefined
      return {
        durationMs: 1200,
        response: {
          modelId: "openai/gpt-test",
        },
        text: `echo: ${text?.text}`,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    })
    const agent = defineAgent({
      capabilities: [
        access({
          chat: {
            resolve: admitChat,
          },
        }),
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      run,
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 7,
          audio: { file_id: "audio-file" },
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.startTyping).toHaveBeenCalledWith("telegram:456", undefined)
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "...")
    expect(adapter.postMessage).toHaveBeenCalledTimes(1)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "echo: hello" })
    expect(admitChat).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        id: "123",
        provider: "telegram",
        username: "maxi",
      }),
      input: expect.objectContaining({
        message: expect.objectContaining({
          attachmentCount: 1,
          id: "7",
          text: "hello",
        }),
      }),
    }))
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        get: expect.any(Function),
      }),
      messages: [expect.objectContaining({
        metadata: expect.objectContaining({
          chat: expect.objectContaining({
            messageId: "7",
            threadId: "telegram:456",
          }),
        }),
        parts: [
          expect.objectContaining({ text: "hello", type: "text" }),
          expect.objectContaining({
            fetchData: expect.any(Function),
            mediaType: "audio/ogg",
            type: "audio",
          }),
        ],
      })],
      run: expect.objectContaining({
        origin: "telegram",
        runId: "telegram:7",
      }),
    }))
  })

  it("does not block chat webhook handling on typing status", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    adapter.startTyping.mockImplementation(() => new Promise(() => {}))
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      run: () => ({ text: "ok" }),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await Promise.race([
      handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 44,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 9,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("webhook blocked on typing status")), 100)),
    ])

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.startTyping).toHaveBeenCalledWith("telegram:456", undefined)
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "ok" })
  })

  it("refreshes chat typing until streamed output starts", async () => {
    vi.useFakeTimers()
    try {
      const { defineAgent } = await import("../src/index.ts")
      const { chat } = await import("../src/capabilities.ts")
      const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
      const adapter = createTestChatAdapter()
      adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
        let text = ""
        for await (const chunk of textStream) {
          if (typeof chunk === "string") text += chunk
          else if (chunk.type === "markdown_text") text += chunk.text
        }
        return { id: "stream-typing", raw: { text }, threadId }
      })
      let runStarted!: () => void
      let finishRun!: () => void
      const runStartedPromise = new Promise<void>(resolve => {
        runStarted = resolve
      })
      const finishRunPromise = new Promise<void>(resolve => {
        finishRun = resolve
      })
      const agent = defineAgent({
        capabilities: [
          chat({
            adapters: {
              telegram: () => adapter as never,
            },
            webhooks: {
              telegram: {},
            },
          }),
        ],
        run: async () => {
          runStarted()
          await finishRunPromise
          return "ok"
        },
      })
      const handler = defineAgentChatWebhookFetchHandler(agent as never)

      const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 144,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 144,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram")

      await runStartedPromise
      expect(adapter.startTyping).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(3)

      finishRun()
      const response = await responsePromise
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      const callsAfterFirstOutput = adapter.startTyping.mock.calls.length
      await vi.advanceTimersByTimeAsync(8000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(callsAfterFirstOutput)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("posts configured chat fallback while streamed webhook work is still running", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    let runStarted!: () => void
    let finishRun!: () => void
    const runStartedPromise = new Promise<void>(resolve => {
      runStarted = resolve
    })
    const finishRunPromise = new Promise<void>(resolve => {
      finishRun = resolve
    })
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          fallbackStreamingPlaceholderText: "Working on it...",
          webhooks: {
            telegram: {},
          },
        }),
      ],
      run: async () => {
        runStarted()
        await finishRunPromise
        return "done"
      },
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 1045,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1045,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    await runStartedPromise
    await Promise.resolve()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "Working on it...")
    expect(adapter.editMessage).not.toHaveBeenCalled()
    await expect(Promise.race([
      responsePromise.then(() => "settled"),
      Promise.resolve("pending"),
    ])).resolves.toBe("pending")

    finishRun()
    const response = await responsePromise

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "done" })
  })

  it("activates Cloudflare env while webhook work runs", async () => {
    const { getActiveCloudflareEnv } = await import("@vite-hub/internal/runtime/cloudflare-env")
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      run: () => String(getActiveCloudflareEnv()?.OPENAI_API_KEY),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 1046,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1046,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram", {
      cloudflare: {
        env: {
          OPENAI_API_KEY: "runtime-openai-key",
        },
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "runtime-openai-key" })
  })

  it("posts chat error fallback when deferred webhook work fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter({ deferMessageProcessing: true })
    const waitUntilTasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          errorFallbackText: "No pude procesar ese mensaje.",
          webhooks: {
            telegram: {},
          },
        }),
      ],
      run: () => {
        throw new Error("transcription failed")
      },
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    try {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 1047,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 1047,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram", {
        waitUntil: task => waitUntilTasks.push(task),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      await Promise.all(waitUntilTasks)
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "No pude procesar ese mensaje.")
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        component: "@vite-hub/agent",
        event: "chat.message.error",
        thread_id: "telegram:456",
      }))
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("lets chat webhooks opt out of streaming model execution", async () => {
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const model = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "generated ok" })),
      stream: vi.fn(async () => {
        throw new Error("stream should not be used")
      }),
      tools: {},
      version: "agent-v1",
    }
    const agent = {
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
      ],
      resolve: vi.fn(async () => model),
    }
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 45,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 10,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(model.generate).toHaveBeenCalledOnce()
    expect(model.stream).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "generated ok" })
  })

  it("runs non-streaming chat webhooks inline for workflow-backed agents", async () => {
    const { workflow } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const adapter = createTestChatAdapter()
    const model = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "generated ok" })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }
    const agent = {
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
      ],
      resolve: vi.fn(async () => model),
      runtime: workflow("support-agent"),
    }
    const handler = defineAgentChatWebhookFetchHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 46,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 11,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(model.generate).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "generated ok" })
    }
    finally {
      resetWorkflowRuntime()
    }
  })

  it("lets agent finish hooks post usage telemetry for non-streaming model chat webhooks", async () => {
    const { chat, staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      const usage = event.extensions.get("usage-telemetry") as { usage?: { totalTokens?: number } } | undefined
      if (chat && usage) {
        await chat.sendMessage?.({
          markdown: `Custom usage: \`${usage.usage?.totalTokens}\` tokens via ${chat.provider}`,
        })
      }
    })
    const model = {
      generate: vi.fn(async () => ({
        durationMs: 900,
        finishReason: "stop",
        response: {
          modelId: "openai/gpt-test",
        },
        text: "generated ok",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
        },
      })),
      stream: vi.fn(async () => {
        throw new Error("stream should not be used")
      }),
      tools: {},
      version: "agent-v1",
    }
    const agent = {
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      resolve: vi.fn(async () => model),
    }
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 47,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 12,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(model.generate).toHaveBeenCalledOnce()
    expect(model.stream).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", { markdown: "generated ok" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "Custom usage: `15` tokens via telegram" })
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toEqual(expect.objectContaining({
      cost: expect.objectContaining({
        amount: "0.0000018",
        currency: "USD",
      }),
      latency: expect.objectContaining({
        durationMs: 900,
      }),
      model: {
        id: "openai/gpt-test",
      },
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    }))
    expect(finish.mock.calls[0]![0].extensions.get("chat")).toEqual(expect.objectContaining({
      provider: "telegram",
      sendMessage: expect.any(Function),
    }))
  })

  it("exposes chat sendMessage to agent finish hooks for chat webhooks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      await chat?.sendMessage?.({ markdown: `side message via ${chat.provider}` })
    })
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "agent answer" }),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 88,
        message: {
          chat: { id: 888, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 88,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(finish).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:888", { markdown: "agent answer" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:888", { markdown: "side message via telegram" })
  })

  it("commits native streamed chat responses before flushing finish hook messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const order: string[] = []
    let streamConsumed!: () => void
    let commitResponse!: () => void
    const streamConsumedPromise = new Promise<void>(resolve => {
      streamConsumed = resolve
    })
    const commitResponsePromise = new Promise<void>(resolve => {
      commitResponse = resolve
    })
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
      let text = ""
      for await (const chunk of textStream) {
        if (typeof chunk === "string") text += chunk
        else if (chunk.type === "markdown_text") text += chunk.text
      }
      order.push(`stream:${text}`)
      streamConsumed()
      await commitResponsePromise
      order.push("stream:committed")
      return { id: "stream-1", raw: { text }, threadId }
    })
    adapter.postMessage.mockImplementation(async (threadId: string, message: unknown) => {
      order.push("post:follow-up")
      return { id: "sent-follow-up", raw: { message }, threadId }
    })
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      await chat?.sendMessage?.({ markdown: "usage ok" })
      order.push("finish:queued")
    })
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "agent answer" }),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 89,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 89,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    try {
      await streamConsumedPromise
      await expect(Promise.race([
        responsePromise.then(() => "settled"),
        Promise.resolve("pending"),
      ])).resolves.toBe("pending")
      expect(adapter.editMessage).not.toHaveBeenCalled()
      expect(adapter.postMessage).not.toHaveBeenCalled()
      await expect(Promise.race([
        responsePromise.then(() => "settled"),
        Promise.resolve("pending"),
      ])).resolves.toBe("pending")

      commitResponse()
      const response = await responsePromise

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(adapter.postMessage).toHaveBeenCalledTimes(1)
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "usage ok" })
      expect(finish).toHaveBeenCalledOnce()
      expect(order.indexOf("stream:committed")).toBeLessThan(order.indexOf("post:follow-up"))
      expect(order).toContain("stream:agent answer")
    }
    finally {
      commitResponse()
    }
  })

  it("does not fail native streamed chats when the final message is already committed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
      let text = ""
      for await (const chunk of textStream) {
        if (typeof chunk === "string") text += chunk
        else if (chunk.type === "markdown_text") text += chunk.text
      }
      return { id: "stream-committed", raw: { text }, threadId }
    })
    adapter.editMessage.mockRejectedValue(new Error("message is not modified"))
    adapter.postMessage.mockImplementation(async (threadId: string, message: unknown) => ({ id: "sent-follow-up", raw: { message }, threadId }))
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      await chat?.sendMessage?.({ markdown: "usage ok" })
    })
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          errorFallbackText: "Sorry, I couldn't process that message.",
          webhooks: {
            telegram: {},
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "agent `answer`" }),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    try {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 90,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 90,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(adapter.editMessage).not.toHaveBeenCalled()
      expect(adapter.postMessage).toHaveBeenCalledTimes(1)
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "usage ok" })
      expect(finish).toHaveBeenCalledOnce()
      expect(consoleError).not.toHaveBeenCalled()
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("flushes deferred non-streaming chat webhook work before returning", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter({ deferMessageProcessing: true })
    adapter.startTyping.mockImplementation(() => new Promise(() => {}))
    let runStarted!: () => void
    let finishRun!: () => void
    const runStartedPromise = new Promise<void>(resolve => {
      runStarted = resolve
    })
    const finishRunPromise = new Promise<void>(resolve => {
      finishRun = resolve
    })
    const run = vi.fn(async () => {
      runStarted()
      await finishRunPromise
      return {
        text: "ok",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    })
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      const usage = event.extensions.get("usage-telemetry")
      if (chat && usage) {
        await chat.sendMessage?.({ markdown: "usage ok" })
      }
    })
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
        usageTelemetry(),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run,
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 48,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 13,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    await runStartedPromise
    await Promise.resolve()
    await expect(Promise.race([
      responsePromise.then(() => "settled"),
      Promise.resolve("pending"),
    ])).resolves.toBe("pending")

    finishRun()
    const response = await responsePromise

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.startTyping).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", { markdown: "ok" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "usage ok" })
    expect(finish).toHaveBeenCalledOnce()
  })

  it("lets agent finish hooks compose usage telemetry and chat follow-up messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access, chat, staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      const usage = event.extensions.get("usage-telemetry") as { usage?: { totalTokens?: number } } | undefined
      if (chat && usage) {
        await chat.sendMessage?.({
          markdown: `Custom usage: \`${usage.usage?.totalTokens}\` tokens via ${chat.provider}`,
        })
      }
    })
    const agent = defineAgent({
      capabilities: [
        access({
          chat: {
            resolve: () => true,
          },
        }),
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        response: {
          modelId: "openai/gpt-test",
        },
        text: "ok",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      }),
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 43,
        message: {
          chat: { id: 789, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 8,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:789", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:789", "sent-1", { markdown: "ok" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:789", { markdown: "Custom usage: `15` tokens via telegram" })
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toEqual(expect.objectContaining({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    }))
    expect(finish.mock.calls[0]![0].extensions.get("chat")).toEqual(expect.objectContaining({
      provider: "telegram",
      sendMessage: expect.any(Function),
    }))
  })

  it("lets access() reject app-specific chat identities", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access, chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "unused")
    const agent = defineAgent({
      capabilities: [
        access({
          chat: {
            resolve: ({ identity }) => identity?.id === "123",
          },
        }),
        chat({
          adapters: { telegram: () => adapter as never },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      run,
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          from: { id: 999 },
          message_id: 7,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
    expect(adapter.postMessage).not.toHaveBeenCalled()
  })

  it("returns Chat SDK adapter webhook responses", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatWebhookFetchHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter({ secret: "secret" })
    const run = vi.fn(() => "unused")
    const agent = defineAgent({
      capabilities: [
        chat({
          adapters: {
            telegram: () => adapter as never,
          },
        }),
      ],
      run,
    })
    const handler = defineAgentChatWebhookFetchHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({ update_id: 42 }),
      headers: { "x-test-secret": "wrong" },
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("Vercel helpers", () => {
  it("returns JSON responses for non-streaming agent calls", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const waitUntil = vi.fn()
    const run = vi.fn(() => ({ raw: { answer: 42 }, text: "ok" }))
    const agent = defineAgent({ run })
    const handler = defineVercelAgentHandler(agent as never, { waitUntil })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "hello", stream: false }),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({ raw: { answer: 42 }, text: "ok" })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ prompt: "hello" }),
    }))
  })

  it("keeps context.request readable for custom run agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const run = vi.fn(async ({ request }) => ({
      text: (await request!.json()).prompt,
    }))
    const handler = defineVercelAgentHandler(defineAgent({ run }) as never, { waitUntil: vi.fn() })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "still readable", stream: false }),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({ text: "still readable" })
  })

  it("returns declared HTTP errors", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const error = new Error("Rejected")
    ;(error as { statusCode?: number }).statusCode = 403
    const handler = defineVercelAgentHandler(defineAgent({ run: () => { throw error } }) as never, { waitUntil: vi.fn() })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "blocked", stream: false }),
      method: "POST",
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Rejected" })
  })
})

describe("Cloudflare helpers", () => {
  it("keeps context.request readable for custom run agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineCloudflareAgentHandler } = await import("../src/cloudflare.ts")
    const run = vi.fn(async ({ request }) => ({
      text: (await request!.json()).prompt,
    }))
    const handler = defineCloudflareAgentHandler(defineAgent({ run }) as never)

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "still readable", stream: false }),
      method: "POST",
    }), {}, { waitUntil: vi.fn() })

    await expect(response.json()).resolves.toMatchObject({ text: "still readable" })
  })

  it("returns declared HTTP errors", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineCloudflareAgentHandler } = await import("../src/cloudflare.ts")
    const error = new Error("Rejected")
    ;(error as { statusCode?: number }).statusCode = 403
    const handler = defineCloudflareAgentHandler(defineAgent({ run: () => { throw error } }) as never)

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "blocked", stream: false }),
      method: "POST",
    }), {}, { waitUntil: vi.fn() })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Rejected" })
  })

})

describe("agent registry helpers", () => {
  it("resolves named agents from a registry", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(getAgentFromRegistry("triager", {} as never, {
      triager: async () => ({ default: agent as never }),
    })).resolves.toBe(agent)
  })

  it("throws clearly for unknown named agents", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")

    await expect(getAgentFromRegistry("triage", {} as never, {
      reviewer: async () => ({} as never),
      triager: async () => ({} as never),
    })).rejects.toThrow("Unknown agent: triage. Did you mean \"triager\"? Discovered agents: reviewer, triager.")
  })
})
