import { beforeEach, describe, expect, it, vi } from "vitest"

const cloudflareStateMock = vi.hoisted(() => ({
  createCloudflareState: vi.fn(options => ({ connect: vi.fn(), provider: "cloudflare-do", options })),
}))

const vercelFunctionsMock = vi.hoisted(() => ({
  waitUntil: vi.fn(),
}))

vi.mock("chat-state-cloudflare-do", () => ({
  ChatStateDO: class ChatStateDO {},
  createCloudflareState: cloudflareStateMock.createCloudflareState,
}))

vi.mock("@vercel/functions", () => ({
  waitUntil: vercelFunctionsMock.waitUntil,
}))

beforeEach(() => {
  cloudflareStateMock.createCloudflareState.mockClear()
  vercelFunctionsMock.waitUntil.mockClear()
})

function runConfigResolved(plugin: { configResolved?: unknown }, config: unknown): void {
  if (typeof plugin.configResolved === "function") {
    plugin.configResolved.call({} as never, config as never)
  }
}

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

  it("exposes chatDevtools without Nitro integration", async () => {
    const { chatDevtools, hubChat } = await import("../src/vite.ts")

    expect("nitro" in chatDevtools()).toBe(false)
    expect(hubChat().nitro).toBeTruthy()
  })

  it("mounts only the Chat DevTools iframe shell", async () => {
    const { chatDevtools, hubChat } = await import("../src/vite.ts")

    expect(chatDevtools().configureServer).toBeTypeOf("function")
    expect(hubChat().configureServer).toBeTypeOf("function")
  })

  it("warns when Chat DevTools is enabled without Vite DevTools", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools()
    const warn = vi.fn()

    runConfigResolved(plugin, {
      chat: undefined,
      logger: { warn },
      plugins: [plugin],
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Chat DevTools requires @vitejs/devtools"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DevTools(), chatDevtools(), nitro"))
  })

  it("does not warn when Vite DevTools is already installed", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools()
    const warn = vi.fn()

    runConfigResolved(plugin, {
      logger: { warn },
      plugins: [{ name: "vite:devtools:server" }, plugin],
    })

    expect(warn).not.toHaveBeenCalled()
  })

  it("registers the Vite DevTools iframe dock by default", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools()
    const ctx = {
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
      viteServer: { resolvedUrls: { local: ["http://localhost:5173/"] } },
    }

    await plugin.devtools?.setup(ctx as never)

    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      icon: "ph:chat-duotone",
      id: "@vitehub/chat",
      remote: {
        originLock: false,
      },
      title: "Chat",
      type: "iframe",
      url: "/__vitehub/chat/devtools-ui",
    }))
    expect(ctx.rpc.register).toHaveBeenCalledTimes(3)
  })

  it("uses the same-origin shell for configured and environment DevTools iframe URLs", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const ctx = {
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
    }

    await chatDevtools({ dev: { devtools: { url: "https://example.com/chat" } } }).devtools?.setup(ctx as never)
    expect(ctx.docks.register).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "/__vitehub/chat/devtools-ui",
    }))

    vi.stubEnv("VITEHUB_CHAT_DEVTOOLS_URL", "http://localhost:3000/chat")
    try {
      await chatDevtools({ dev: { devtools: { url: "https://example.com/chat" } } }).devtools?.setup(ctx as never)
    }
    finally {
      vi.unstubAllEnvs()
    }

    expect(ctx.docks.register).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "/__vitehub/chat/devtools-ui",
    }))
  })

  it("serves the iframe shell from the configured DevTools URL", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const use = vi.fn()
    const plugin = chatDevtools({ dev: { devtools: { url: "https://example.com/chat" } } })
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `<script type="module" src="/_nuxt/app.js"></script><script>window.__NUXT__={config:{app:{cdnURL:""}}}</script>`,
      { headers: { "content-type": "text/html" } },
    ))
    const response = {
      end: vi.fn(),
      setHeader: vi.fn(),
      statusCode: 200,
    }

    const configureServer = plugin.configureServer as (server: unknown) => void
    configureServer({ middlewares: { use } })
    await use.mock.calls[0][1]({}, response, vi.fn())

    expect(use.mock.calls[0][0]).toBe("/__vitehub/chat/devtools-ui")
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/chat")
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining(`src="https://example.com/_nuxt/app.js"`))
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining(`cdnURL:"https://example.com"`))
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining(`history.replaceState(history.state,"","/chat"+location.search+location.hash)`))

    fetchMock.mockRestore()
  })

  it("sends the selected chat name through the DevTools bridge", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools()
    const ctx = {
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
          setup: () => { handler: (params: { chatName?: string, text?: string }) => Promise<unknown> }
        }

      await expect(sendDefinition.setup().handler({ chatName: "support", text: "hello" })).resolves.toMatchObject({
        chatName: "support",
        status: "Sent",
      })
    }
    finally {
      vi.unstubAllGlobals()
    }

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      chatName: "support",
      text: "hello",
    })
  })

  it("gets and clears state through the DevTools bridge", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools()
    const ctx = {
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
      viteServer: { resolvedUrls: { local: ["http://localhost:5173/"] } },
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(init.body as string)
      return new Response(JSON.stringify({
        chatName: payload.chatName || "chat",
        chats: ["chat"],
        messages: [],
        status: payload.clear ? "Cleared" : "Ready",
      }), { headers: { "content-type": "application/json" } })
    })

    vi.stubGlobal("fetch", fetchMock)
    try {
      await plugin.devtools?.setup(ctx as never)
      const definitions = ctx.rpc.register.mock.calls.map(([definition]) => definition)
      const getStateDefinition = definitions.find(definition => definition.name === "@vitehub/chat:get-state") as {
        setup: () => { handler: (params?: { chatName?: string }) => Promise<unknown> }
      }
      const clearDefinition = definitions.find(definition => definition.name === "@vitehub/chat:clear") as {
        setup: () => { handler: (params?: { chatName?: string }) => Promise<unknown> }
      }

      await expect(getStateDefinition.setup().handler({ chatName: "chat" })).resolves.toMatchObject({ status: "Ready" })
      await expect(clearDefinition.setup().handler({ chatName: "chat" })).resolves.toMatchObject({ status: "Cleared" })
    }
    finally {
      vi.unstubAllGlobals()
    }

    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1]!.body as string))).toEqual([
      { chatName: "chat" },
      { chatName: "chat", clear: true },
    ])
  })

  it("does not register Vite DevTools when disabled", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools({ dev: { devtools: false } })
    const ctx = {
      docks: { register: vi.fn() },
      rpc: { register: vi.fn() },
      viteConfig: { server: { port: 5173 } },
    }

    await plugin.devtools?.setup(ctx as never)

    expect(ctx.docks.register).not.toHaveBeenCalled()
    expect(ctx.rpc.register).not.toHaveBeenCalled()
  })

  it("does not warn when Chat DevTools is disabled", async () => {
    const { chatDevtools } = await import("../src/vite.ts")
    const plugin = chatDevtools({ dev: { devtools: false } })
    const warn = vi.fn()

    runConfigResolved(plugin, {
      logger: { warn },
      plugins: [plugin],
    })

    expect(warn).not.toHaveBeenCalled()
  })
})
