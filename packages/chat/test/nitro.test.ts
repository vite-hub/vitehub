import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

const runtimeConfigMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}))

vi.mock("nitro/runtime-config", () => ({
  useRuntimeConfig: () => runtimeConfigMock.value,
}))

beforeEach(() => {
  runtimeConfigMock.value = {}
})

function createEvent(platform: string | undefined, waitUntil = vi.fn()) {
  return {
    context: {
      cloudflare: {
        context: { waitUntil },
        env: { CHAT_STATE: "namespace" },
      },
      params: platform ? { platform } : {},
    },
    req: new Request("https://example.com/api/webhooks/telegram", { method: "POST" }),
    waitUntil,
  }
}

function createNitroStub(rootDir: string, chat: unknown = {}) {
  const hooks: Record<string, Function[]> = {}
  return {
    hooks: {
      hook(name: string, handler: Function) {
        hooks[name] ||= []
        hooks[name]?.push(handler)
      },
    },
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    options: {
      alias: {} as Record<string, string>,
      buildDir: ".nitro",
      chat,
      cloudflare: undefined as undefined | {
        wrangler?: {
          durable_objects?: { bindings?: Array<{ class_name: string, name: string }> }
          migrations?: Array<{ new_sqlite_classes?: string[], tag: string }>
        }
      },
      handlers: [] as Array<{ handler: string, method?: string, route: string }>,
      imports: {},
      externals: {} as { inline?: string[] },
      output: {
        serverDir: join(rootDir, ".output", "server"),
      },
      plugins: [] as string[],
      preset: "cloudflare-module",
      rootDir,
      runtimeConfig: {} as Record<string, unknown>,
    },
    testHooks: hooks,
  }
}

async function writeChat(rootDir: string, name: string, contents = "export default {}") {
  const file = join(rootDir, "server", "chats", `${name}.ts`)
  await mkdir(join(rootDir, "server", "chats"), { recursive: true })
  await writeFile(file, contents, "utf8")
  return file
}

describe("defineChatWebhookHandler", () => {
  it("uses the route platform and forwards Nitro waitUntil", async () => {
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const waitUntil = vi.fn()
    const task = Promise.resolve()
    const webhook = vi.fn((_request: Request, options: { waitUntil: (promise: Promise<unknown>) => void }) => {
      options.waitUntil(task)
      return new Response("ok")
    })
    const handler = defineChatWebhookHandler({
      webhooks: { telegram: webhook },
    } as never)

    const response = await handler(createEvent("telegram", waitUntil) as never)

    expect(response).toBeInstanceOf(Response)
    expect(webhook).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ waitUntil: expect.any(Function) }))
    expect(waitUntil).toHaveBeenCalledWith(task)
  })

  it("exposes runtime config, Cloudflare runtime, and lifecycle hooks", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    runtimeConfigMock.value = { telegram: { token: "secret" } }
    const calls: string[] = []
    const webhook = vi.fn(() => new Response("ok"))
    const adapters = vi.fn((context) => {
      expect(context.runtimeConfig).toBe(runtimeConfigMock.value)
      expect(context.cloudflare?.env?.CHAT_STATE).toBe("namespace")
      expect(context.memo("value", () => "created")).toBe("created")
      expect(context.memo("value", () => "other")).toBe("created")
      return {}
    })
    const chat = defineChat({
      adapters,
      setup(bot: { webhooks: Record<string, unknown> }) {
        const webhooks = bot.webhooks as Record<string, unknown>
        webhooks.telegram = webhook
      },
      state: {} as never,
      userName: "Quiver Chat",
    })
    const handler = defineChatWebhookHandler(chat, {
      lifecycleHooks: {
        request: () => {
          calls.push("request")
        },
        resolved: (context) => {
          calls.push("resolved")
          expect(context.bot).toBeTruthy()
        },
        webhook: (context) => {
          calls.push("webhook")
          expect(context.bot).toBeTruthy()
        },
      },
    })

    await handler(createEvent("telegram") as never)

    expect(adapters).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(["request", "resolved", "webhook"])
  })

  it("runs definition hooks before explicit handler hooks", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const calls: string[] = []
    const webhook = vi.fn(() => new Response("ok"))
    const chat = defineChat({
      adapters: {},
      lifecycleHooks: {
        request: () => {
          calls.push("definition:request")
        },
        resolved: (context: { bot: unknown }) => {
          calls.push("definition:resolved")
          expect(context.bot).toBeTruthy()
        },
        webhook: () => {
          calls.push("definition:webhook")
        },
      },
      setup(bot: { webhooks: Record<string, unknown> }) {
        const webhooks = bot.webhooks as Record<string, unknown>
        webhooks.telegram = webhook
      },
      state: {} as never,
      userName: "Quiver Chat",
    } as never)
    const handler = defineChatWebhookHandler(chat, {
      lifecycleHooks: {
        request: () => {
          calls.push("handler:request")
        },
        resolved: (context) => {
          calls.push("handler:resolved")
          expect(context.bot).toBeTruthy()
        },
        webhook: () => {
          calls.push("handler:webhook")
        },
      },
    })

    await handler(createEvent("telegram") as never)

    expect(calls).toEqual([
      "definition:request",
      "handler:request",
      "definition:resolved",
      "handler:resolved",
      "definition:webhook",
      "handler:webhook",
    ])
  })

  it("supports a fixed platform option", async () => {
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const webhook = vi.fn(() => new Response("ok"))
    const handler = defineChatWebhookHandler({
      webhooks: { telegram: webhook },
    } as never, { platform: "telegram" })

    await handler(createEvent(undefined) as never)

    expect(webhook).toHaveBeenCalledTimes(1)
  })

  it("returns a clear 404 for unknown platforms and calls error hooks", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const calls: string[] = []
    const definitionError = vi.fn((_error, context) => {
      calls.push(`definition:${context.platform}`)
    })
    const handlerError = vi.fn((_error, context) => {
      calls.push(`handler:${context.platform}`)
    })
    const handler = defineChatWebhookHandler(defineChat({
      adapters: {},
      lifecycleHooks: { error: definitionError },
      state: {} as never,
      userName: "Quiver Chat",
    }), {
      lifecycleHooks: { error: handlerError },
    })

    await expect(handler(createEvent("missing") as never)).rejects.toMatchObject({
      status: 404,
      statusMessage: "Unknown chat platform: missing",
    })
    expect(definitionError).toHaveBeenCalledWith(expect.objectContaining({ statusMessage: "Unknown chat platform: missing" }), expect.any(Object))
    expect(handlerError).toHaveBeenCalledWith(expect.objectContaining({ statusMessage: "Unknown chat platform: missing" }), expect.any(Object))
    expect(calls).toEqual(["definition:missing", "handler:missing"])
  })

  it("keeps raw Chat SDK inputs hook-free", async () => {
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const calls: string[] = []
    const webhook = vi.fn(() => new Response("ok"))
    const handler = defineChatWebhookHandler({ webhooks: { telegram: webhook } } as never, {
      lifecycleHooks: {
        request: () => {
          calls.push("handler:request")
        },
        webhook: () => {
          calls.push("handler:webhook")
        },
      },
    })

    await handler(createEvent("telegram") as never)

    expect(webhook).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(["handler:request", "handler:webhook"])
  })
})

describe("Nitro module", () => {
  it("discovers Vite suffix and Nitro server chat definitions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-discovery-"))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "bot.chat.ts"), "export default {}", "utf8")
    await writeChat(rootDir, "bot")

    const { discoverChatDefinitions } = await import("../src/discovery.ts")

    expect(discoverChatDefinitions({ rootDir })).toMatchObject([{ name: "bot" }])
    expect(discoverChatDefinitions({ mode: "nitro-server-chats", scanDirs: [join(rootDir, "server")] })).toMatchObject([{ name: "bot" }])
  })

  it("fails on duplicate discovered chat names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-duplicates-"))
    await mkdir(join(rootDir, "src", "nested"), { recursive: true })
    await writeFile(join(rootDir, "src", "bot.chat.ts"), "export default {}", "utf8")
    await writeFile(join(rootDir, "bot.chat.ts"), "export default {}", "utf8")
    const { discoverChatDefinitions } = await import("../src/discovery.ts")

    expect(() => discoverChatDefinitions({ rootDir })).toThrow("Duplicate chat name")
  })

  it("merges Cloudflare DO config idempotently", async () => {
    const { configureCloudflareChatState } = await import("../src/integrations/cloudflare.ts")
    const target = {
      cloudflare: {
        wrangler: {
          durable_objects: {
            bindings: [{ class_name: "ChatStateDO", name: "CHAT_STATE" }],
          },
          migrations: [{ new_sqlite_classes: ["ChatStateDO"], tag: "v1" }],
        },
      },
    }

    configureCloudflareChatState(target, {
      binding: "CHAT_STATE",
      className: "ChatStateDO",
      migrationTag: "v1",
    })

    expect(target.cloudflare.wrangler.durable_objects.bindings).toEqual([
      { class_name: "ChatStateDO", name: "CHAT_STATE" },
    ])
    expect(target.cloudflare.wrangler.migrations).toEqual([
      { new_sqlite_classes: ["ChatStateDO"], tag: "v1" },
    ])
  })

  it("wires defaults, generated route, aliases, imports, runtime config, plugin, and Cloudflare DO config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-"))
    await writeChat(rootDir, "bot")
    const nitro = createNitroStub(rootDir, {
      cloudflare: {
        durableObjectState: true,
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      imports: true,
      webhook: {
        chatParam: "chat",
        route: "/api/webhooks/[platform]",
        routeParam: "platform",
      },
    })
    expect(nitro.options.handlers).toHaveLength(1)
    expect(nitro.options.handlers[0]).toMatchObject({
      method: "POST",
      route: "/api/webhooks/:platform",
    })
    expect(nitro.options.alias["@vitehub/chat"]).toContain("/packages/chat/src/index.ts")
    expect(nitro.options.alias["@vitehub/chat/nitro"]).toContain("/packages/chat/src/nitro.ts")
    expect(nitro.options.plugins.some(plugin => plugin.includes("/packages/chat/src/runtime/nitro-plugin.ts"))).toBe(true)
    expect(nitro.options.externals.inline).toEqual(expect.arrayContaining(["@vitehub/chat", "chat", "chat-state-cloudflare-do"]))
    expect(JSON.stringify(nitro.options.imports)).toContain("defineChat")
    expect(JSON.stringify(nitro.options.imports)).toContain("defineChatWebhookHandler")
    expect(JSON.stringify(nitro.options.imports)).toContain("defineChatWebhookRegistryHandler")
    expect(nitro.options.cloudflare).toMatchObject({
      wrangler: {
        durable_objects: {
          bindings: [{ class_name: "ChatStateDO", name: "CHAT_STATE" }],
        },
        migrations: [{ new_sqlite_classes: ["ChatStateDO"], tag: "v1" }],
      },
    })

    const routeFile = nitro.options.handlers[0]!.handler
    const routeContents = await readFile(routeFile, "utf8")
    expect(routeContents).toContain("defineChatWebhookHandler(chat")
    expect(routeContents).toContain("inferredName: \"bot\"")
  })

  it("honors disabled webhook and imports", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-disabled-"))
    await writeChat(rootDir, "bot")
    const nitro = createNitroStub(rootDir, {
      imports: false,
      webhook: false,
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.handlers).toHaveLength(0)
    expect(nitro.options.imports).toEqual({})
    expect(nitro.options.plugins.some(plugin => plugin.includes("/packages/chat/src/runtime/nitro-plugin.ts"))).toBe(true)
  })

  it("requires a chat route param for multiple discovered chats", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-multiple-"))
    await writeChat(rootDir, "bot")
    await writeChat(rootDir, "support")
    const nitro = createNitroStub(rootDir)
    const module = (await import("../src/nitro/module.ts")).default

    await expect(module.setup(nitro as never)).rejects.toThrow("chat.webhook.route does not include [chat]")
  })

  it("generates a registry route for multiple chats with a chat param", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-registry-"))
    await writeChat(rootDir, "bot")
    await writeChat(rootDir, "support")
    const nitro = createNitroStub(rootDir, {
      webhook: "/api/webhooks/[chat]/[platform]",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.handlers[0]).toMatchObject({
      method: "POST",
      route: "/api/webhooks/:chat/:platform",
    })
    expect(await readFile(nitro.options.handlers[0]!.handler, "utf8")).toContain("defineChatWebhookRegistryHandler")
  })
})
