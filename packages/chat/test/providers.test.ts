import { beforeEach, describe, expect, it, vi } from "vitest"

const cloudflareStateMock = vi.hoisted(() => ({
  createCloudflareState: vi.fn(options => ({ connect: vi.fn(), provider: "cloudflare-do", options })),
}))

const vercelFunctionsMock = vi.hoisted(() => ({
  waitUntil: vi.fn(),
}))

const viteDevtoolsMock = vi.hoisted(() => ({
  context: {
    docks: {
      values: vi.fn(() => [{
        action: { importFrom: "virtual:action" },
        id: "example",
        type: "action",
      }]),
    },
  },
  createDevToolsContext: vi.fn(),
  createDevToolsMiddleware: vi.fn(),
  middleware: vi.fn(),
}))

vi.mock("chat-state-cloudflare-do", () => ({
  ChatStateDO: class ChatStateDO {},
  createCloudflareState: cloudflareStateMock.createCloudflareState,
}))

vi.mock("@vercel/functions", () => ({
  waitUntil: vercelFunctionsMock.waitUntil,
}))

vi.mock("@vitejs/devtools", () => ({
  createDevToolsContext: viteDevtoolsMock.createDevToolsContext,
  createDevToolsMiddleware: viteDevtoolsMock.createDevToolsMiddleware,
}))

beforeEach(() => {
  cloudflareStateMock.createCloudflareState.mockClear()
  vercelFunctionsMock.waitUntil.mockClear()
  viteDevtoolsMock.createDevToolsContext.mockReset()
  viteDevtoolsMock.createDevToolsMiddleware.mockReset()
  viteDevtoolsMock.middleware.mockReset()
  viteDevtoolsMock.context.docks.values.mockClear()
  viteDevtoolsMock.createDevToolsContext.mockResolvedValue(viteDevtoolsMock.context)
  viteDevtoolsMock.createDevToolsMiddleware.mockResolvedValue({ middleware: viteDevtoolsMock.middleware })
})

describe("Cloudflare helpers", () => {
  it("looks up the Durable Object binding from request context", async () => {
    const { cloudflareDurableObjectState } = await import("../src/cloudflare.ts")
    const namespace = { idFromName: vi.fn() }
    const shardKey = (threadId: string) => threadId.split(":")[0] || "default"

    const state = await cloudflareDurableObjectState({
      binding: "CHAT_STATE",
      locationHint: "wnam",
      name: "quiver-chat",
      shardKey,
    }).resolve({
      cloudflare: {
        env: { CHAT_STATE: namespace },
      },
      memo: vi.fn(),
      runtime: "cloudflare",
      waitUntil: vi.fn(),
    })

    await state.connect()

    expect(cloudflareStateMock.createCloudflareState).toHaveBeenCalledWith({
      locationHint: "wnam",
      name: "quiver-chat",
      namespace,
      shardKey,
    })
  })

  it("uses the Nitro-provided Durable Object state name when omitted", async () => {
    const { cloudflareDurableObjectState } = await import("../src/cloudflare.ts")
    const namespace = { idFromName: vi.fn() }

    const state = await cloudflareDurableObjectState().resolve({
      cloudflare: {
        durableObjectStateName: "quiver-chat",
        env: { CHAT_STATE: namespace },
      },
      memo: vi.fn(),
      runtime: "nitro",
      waitUntil: vi.fn(),
    })

    await state.connect()

    expect(cloudflareStateMock.createCloudflareState).toHaveBeenCalledWith({
      locationHint: undefined,
      name: "quiver-chat",
      namespace,
      shardKey: undefined,
    })
  })

  it("throws a clear error for missing Durable Object bindings", async () => {
    const { cloudflareDurableObjectState } = await import("../src/cloudflare.ts")

    expect(() => cloudflareDurableObjectState().resolve({
      cloudflare: { env: {} },
      memo: vi.fn(),
      runtime: "cloudflare",
      waitUntil: vi.fn(),
    })).toThrow("Missing Cloudflare Durable Object binding CHAT_STATE")
  })

  it("uses in-memory state during Nitro dev initialization without Cloudflare bindings", async () => {
    const { cloudflareDurableObjectState } = await import("../src/cloudflare.ts")
    const values = new Map<string, unknown>()
    const memo = <T>(key: string, create: () => T): T => {
      if (!values.has(key)) values.set(key, create())
      return values.get(key) as T
    }
    const state = await cloudflareDurableObjectState().resolve({
      dev: true,
      memo,
      runtime: "nitro",
      runtimeConfig: { chat: { dev: { initialize: true, localStateFallback: true }, imports: true, provider: "auto", webhook: false } } as never,
      waitUntil: vi.fn(),
    })

    await state.connect()
    await state.set("key", "value")

    await expect(state.get("key")).resolves.toBe("value")
    expect(cloudflareStateMock.createCloudflareState).not.toHaveBeenCalled()
  })

  it("keeps missing Cloudflare bindings strict when local state fallback is disabled", async () => {
    const { cloudflareDurableObjectState } = await import("../src/cloudflare.ts")

    expect(() => cloudflareDurableObjectState().resolve({
      dev: true,
      memo: vi.fn(),
      runtime: "nitro",
      runtimeConfig: { chat: { dev: { initialize: true, localStateFallback: false }, imports: true, provider: "auto", webhook: false } } as never,
      waitUntil: vi.fn(),
    })).toThrow("Missing Cloudflare Durable Object binding CHAT_STATE")
  })

  it("passes ctx.waitUntil to raw Cloudflare webhook handlers", async () => {
    const { defineCloudflareChatHandler } = await import("../src/cloudflare.ts")
    const task = Promise.resolve()
    const waitUntil = vi.fn()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      return new Response("ok")
    })
    const handler = defineCloudflareChatHandler({ webhooks: { telegram: webhook } } as never)

    await handler(new Request("https://example.com/api/webhooks/telegram"), {}, { waitUntil })

    expect(waitUntil).toHaveBeenCalledWith(task)
  })
})

describe("Vercel helpers", () => {
  it("passes @vercel/functions waitUntil to raw Vercel webhook handlers", async () => {
    const { defineVercelChatHandler } = await import("../src/vercel.ts")
    const task = Promise.resolve()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      return new Response("ok")
    })
    const handler = defineVercelChatHandler({ webhooks: { telegram: webhook } } as never)

    await handler(new Request("https://example.com/api/webhooks/telegram"))

    expect(vercelFunctionsMock.waitUntil).toHaveBeenCalledWith(task)
  })

  it("uses an explicit waitUntil override", async () => {
    const { defineVercelChatHandler } = await import("../src/vercel.ts")
    const task = Promise.resolve()
    const waitUntil = vi.fn()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      return new Response("ok")
    })
    const handler = defineVercelChatHandler({ webhooks: { telegram: webhook } } as never, { waitUntil })

    await handler(new Request("https://example.com/api/webhooks/telegram"))

    expect(waitUntil).toHaveBeenCalledWith(task)
    expect(vercelFunctionsMock.waitUntil).not.toHaveBeenCalled()
  })
})

describe("Vite plugin", () => {
  it("attaches Nitro and merges server noExternal", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()

    expect(plugin.nitro).toBeTruthy()
    const hook = plugin.configEnvironment
    const result = typeof hook === "function"
      ? hook.call({} as never, "ssr", {
          consumer: "server",
          resolve: { noExternal: ["existing"] },
        } as never, {} as never)
      : undefined

    expect(result).toMatchObject({
      resolve: { noExternal: ["existing", "@vitehub/chat"] },
    })
  })

  it("exposes hubChat options through Vite config", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat({ webhook: "/api/webhooks/[platform]" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toEqual({ chat: { webhook: "/api/webhooks/[platform]" } })
  })

  it("enables Vite DevTools automatically in dev", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "serve", mode: "development" })
      : undefined

    expect(result).toMatchObject({ devtools: { enabled: true } })
  })

  it("mounts the Vite DevTools middleware by default", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()
    const use = vi.fn()
    const devServer = {
      config: {
        plugins: [plugin],
        root: "/tmp/app",
        server: { host: "127.0.0.1", port: 5173 },
      },
      middlewares: { use },
    }

    await (plugin.configureServer as (server: unknown) => Promise<void>)(devServer)

    expect(viteDevtoolsMock.createDevToolsContext).toHaveBeenCalledWith(devServer.config, devServer)
    expect(viteDevtoolsMock.createDevToolsMiddleware).toHaveBeenCalledWith(expect.objectContaining({
      context: viteDevtoolsMock.context,
      cwd: "/tmp/app",
      websocket: { host: "127.0.0.1" },
    }))
    expect(use).toHaveBeenCalledWith("/.devtools/", viteDevtoolsMock.middleware)
    expect((plugin.resolveId as (id: string) => string)("/.devtools-client-imports.js")).toBe("/.devtools-client-imports.js")
    expect((plugin.load as (id: string) => string)("/.devtools-client-imports.js")).toContain("virtual:action")
  })

  it("does not duplicate existing Vite DevTools middleware", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()
    const use = vi.fn()

    await (plugin.configureServer as (server: unknown) => Promise<void>)({
      config: {
        plugins: [{ name: "vite:devtools:server" }],
        root: "/tmp/app",
        server: { port: 5173 },
      },
      middlewares: { use },
    } as never)

    expect(use).not.toHaveBeenCalled()
    expect(viteDevtoolsMock.createDevToolsContext).not.toHaveBeenCalled()
  })

  it("registers the Vite DevTools JSON Render dock by default", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()
    const ui = { updateSpec: vi.fn(), updateState: vi.fn() }
    const ctx = {
      createJsonRenderer: vi.fn(() => ui),
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
      viteServer: { resolvedUrls: { local: ["http://localhost:5173/"] } },
    }

    await plugin.devtools?.setup(ctx as never)

    expect(ctx.createJsonRenderer).toHaveBeenCalledWith(expect.objectContaining({
      elements: expect.objectContaining({
        "chat-input": expect.objectContaining({ type: "TextInput" }),
        "clear-button": expect.objectContaining({ type: "Button" }),
        "message-input": expect.objectContaining({ type: "TextInput" }),
        "send-button": expect.objectContaining({ type: "Button" }),
        transcript: expect.objectContaining({ type: "Stack" }),
      }),
      root: "root",
    }))
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      icon: "ph:chat-duotone",
      id: "@vitehub/chat",
      title: "Chat",
      type: "json-render",
      ui,
    }))
    expect(ctx.rpc.register).toHaveBeenCalledTimes(2)
  })

  it("sends the selected chat name through the DevTools bridge", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat()
    const ui = { updateSpec: vi.fn(), updateState: vi.fn() }
    const ctx = {
      createJsonRenderer: vi.fn(() => ui),
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
      viteServer: { resolvedUrls: { local: ["http://localhost:5173/"] } },
    }
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      chatName: "support",
      chats: ["default", "support"],
      messages: [],
      status: "Sent",
    }), { headers: { "content-type": "application/json" } }))

    vi.stubGlobal("fetch", fetchMock)
    try {
      await plugin.devtools?.setup(ctx as never)
      const sendDefinition = ctx.rpc.register.mock.calls
        .map(([definition]) => definition)
        .find(definition => definition.name === "@vitehub/chat:send") as {
          setup: () => { handler: (params: { chatName?: string, text?: string }) => Promise<void> }
        }

      await sendDefinition.setup().handler({ chatName: "support", text: "hello" })
    }
    finally {
      vi.unstubAllGlobals()
    }

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      chatName: "support",
      text: "hello",
    })
    expect(ui.updateSpec).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        "chat-name": "support",
      }),
    }))
  })

  it("does not register Vite DevTools when disabled", async () => {
    const { hubChat } = await import("../src/vite.ts")
    const plugin = hubChat({ dev: { devtools: false } })
    const ctx = {
      createJsonRenderer: vi.fn(),
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
    }

    await plugin.devtools?.setup(ctx as never)

    expect(ctx.createJsonRenderer).not.toHaveBeenCalled()
    expect(ctx.docks.register).not.toHaveBeenCalled()
    expect(ctx.rpc.register).not.toHaveBeenCalled()
  })
})
