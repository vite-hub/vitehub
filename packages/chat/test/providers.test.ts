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

  it("can await raw Cloudflare webhook waitUntil tasks inline", async () => {
    const { defineCloudflareChatHandler } = await import("../src/cloudflare.ts")
    const waitUntil = vi.fn()
    let completed = false
    const task = (async () => {
      await Promise.resolve()
      completed = true
    })()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      return new Response("ok")
    })
    const handler = defineCloudflareChatHandler({ webhooks: { telegram: webhook } } as never, { processing: "inline" })

    await handler(new Request("https://example.com/api/webhooks/telegram"), {}, { waitUntil })

    expect(waitUntil).not.toHaveBeenCalled()
    expect(completed).toBe(true)
  })

  it("awaits all raw Cloudflare inline tasks when one rejects", async () => {
    const { defineCloudflareChatHandler } = await import("../src/cloudflare.ts")
    const waitUntil = vi.fn()
    let completed = false
    const rejected = (async () => {
      await Promise.resolve()
      throw new Error("task failed")
    })()
    const completedTask = (async () => {
      await Promise.resolve()
      await Promise.resolve()
      completed = true
    })()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(rejected)
      options.waitUntil(completedTask)
      return new Response("ok")
    })
    const handler = defineCloudflareChatHandler({ webhooks: { telegram: webhook } } as never, { processing: "inline" })

    await expect(handler(new Request("https://example.com/api/webhooks/telegram"), {}, { waitUntil })).rejects.toThrow("task failed")

    expect(waitUntil).not.toHaveBeenCalled()
    expect(completed).toBe(true)
  })

  it("awaits raw Cloudflare inline tasks when the webhook throws", async () => {
    const { defineCloudflareChatHandler } = await import("../src/cloudflare.ts")
    const waitUntil = vi.fn()
    let completed = false
    const task = (async () => {
      await Promise.resolve()
      completed = true
    })()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      throw new Error("webhook failed")
    })
    const handler = defineCloudflareChatHandler({ webhooks: { telegram: webhook } } as never, { processing: "inline" })

    await expect(handler(new Request("https://example.com/api/webhooks/telegram"), {}, { waitUntil })).rejects.toThrow("webhook failed")

    expect(waitUntil).not.toHaveBeenCalled()
    expect(completed).toBe(true)
  })

  it("keeps raw Cloudflare webhook errors when inline tasks also reject", async () => {
    const { defineCloudflareChatHandler } = await import("../src/cloudflare.ts")
    const waitUntil = vi.fn()
    let completed = false
    const rejected = Promise.reject(new Error("task failed"))
    const completedTask = (async () => {
      await Promise.resolve()
      completed = true
    })()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(rejected)
      options.waitUntil(completedTask)
      throw new Error("webhook failed")
    })
    const handler = defineCloudflareChatHandler({ webhooks: { telegram: webhook } } as never, { processing: "inline" })

    await expect(handler(new Request("https://example.com/api/webhooks/telegram"), {}, { waitUntil })).rejects.toThrow("webhook failed")

    expect(waitUntil).not.toHaveBeenCalled()
    expect(completed).toBe(true)
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
})
