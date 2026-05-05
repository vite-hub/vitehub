import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

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
          name?: string
          durable_objects?: { bindings?: Array<{ class_name: string, name: string }> }
          migrations?: Array<{ new_sqlite_classes?: string[], tag: string }>
        }
      },
      dev: true,
      handlers: [] as Array<{ handler: string, method?: string, route: string }>,
      imports: {},
      externals: {} as { inline?: string[] },
      output: {
        serverDir: join(rootDir, ".output", "server"),
      },
      plugins: [] as string[],
      preset: "cloudflare-module",
      rootDir,
      rollupConfig: {} as { plugins?: unknown[] },
      runtimeConfig: {} as Record<string, unknown>,
    },
    testHooks: hooks,
  }
}

interface ChatCloudflareExportsPlugin {
  load: (id: string) => string | undefined
  renderChunk: (code: string, chunk: { fileName: string, isEntry: boolean }) => { code: string, map: null } | null | undefined
  resolveId: (id: string) => string | undefined
}

function getChatCloudflareExportsPlugin(nitro: ReturnType<typeof createNitroStub>, className: string): ChatCloudflareExportsPlugin | undefined {
  return nitro.options.rollupConfig.plugins?.find(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === `vitehub-chat-cloudflare-exports:${className}`) as ChatCloudflareExportsPlugin | undefined
}

async function writeChat(rootDir: string, name: string, contents = "export default {}") {
  const file = join(rootDir, "server", "chats", `${name}.ts`)
  await mkdir(join(rootDir, "server", "chats"), { recursive: true })
  await writeFile(file, contents, "utf8")
  return file
}

async function writeSingleChat(rootDir: string, contents = "export default {}") {
  const file = join(rootDir, "server", "chat.ts")
  await mkdir(join(rootDir, "server"), { recursive: true })
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

  it("forwards Node-style Nitro request bodies to webhooks", async () => {
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    const webhook = vi.fn(async (request: Request) => new Response(await request.text()))
    const handler = defineChatWebhookHandler({
      webhooks: { telegram: webhook },
    } as never)
    const req = Readable.from(["telegram-payload"]) as Readable & {
      headers: Record<string, string>
      method: string
      url: string
    }
    req.headers = {
      "content-type": "text/plain",
      host: "example.com",
    }
    req.method = "POST"
    req.url = "/api/webhooks/telegram"

    const response = await handler({
      context: { params: { platform: "telegram" } },
      req,
      waitUntil: vi.fn(),
    } as never) as Response

    await expect(response.text()).resolves.toBe("telegram-payload")
    expect(webhook).toHaveBeenCalledTimes(1)
  })

  it("exposes runtime config, Cloudflare runtime, and lifecycle hooks", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatWebhookHandler } = await import("../src/nitro.ts")
    runtimeConfigMock.value = { chat: { cloudflare: { durableObjectState: { name: "quiver-chat" } } }, telegram: { token: "secret" } }
    const calls: string[] = []
    const webhook = vi.fn(() => new Response("ok"))
    const adapters = vi.fn((context) => {
      expect(context.runtimeConfig).toBe(runtimeConfigMock.value)
      expect(context.cloudflare?.env?.CHAT_STATE).toBe("namespace")
      expect(context.cloudflare?.durableObjectStateName).toBe("quiver-chat")
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

  it("initializes a dev chat once with a dev Nitro context", async () => {
    const { defineChat } = await import("../src/index.ts")
    const { defineChatDevInitializer } = await import("../src/nitro.ts")
    runtimeConfigMock.value = { chat: { dev: { localStateFallback: true } } }
    const initialize = vi.fn()
    const adapters = vi.fn((context) => {
      expect(context.dev).toBe(true)
      expect(context.runtime).toBe("nitro")
      expect(context.runtimeConfig).toBe(runtimeConfigMock.value)
      return {}
    })
    const chat = defineChat({
      adapters,
      setup(bot: { initialize: () => Promise<void> }) {
        bot.initialize = initialize
      },
      state: {
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as never,
      userName: "Quiver Chat",
    })
    const initializeDev = defineChatDevInitializer(chat)

    await initializeDev()
    await initializeDev()

    expect(adapters).toHaveBeenCalledTimes(1)
    expect(initialize).toHaveBeenCalledTimes(1)
  })
})

describe("Nitro module", () => {
  it("discovers Vite suffix and Nitro server chat definitions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-discovery-"))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "bot.chat.ts"), "export default {}", "utf8")
    await writeSingleChat(rootDir)
    await writeChat(rootDir, "bot")

    const { discoverChatDefinitions } = await import("../src/discovery.ts")

    expect(discoverChatDefinitions({ rootDir })).toMatchObject([{ name: "bot" }])
    expect(discoverChatDefinitions({ mode: "nitro-server-chats", scanDirs: [join(rootDir, "server")] })).toMatchObject([
      { name: "bot" },
      { name: "chat" },
    ])
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
    await writeSingleChat(rootDir, [
      `import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"`,
      `export default defineChat({ state: cloudflareDurableObjectState(), adapters: {} })`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      dev: {
        devtools: {
          url: "https://devtools.vitehub.dev/chat",
        },
        initialize: true,
        localStateFallback: true,
      },
      imports: true,
      webhook: {
        chatParam: "chat",
        route: "/api/webhooks/[platform]",
        routeParam: "platform",
      },
    })
    expect(nitro.options.handlers).toHaveLength(2)
    expect(nitro.options.handlers[0]).toMatchObject({
      method: "POST",
      route: "/api/webhooks/:platform",
    })
    expect(nitro.options.handlers[1]).toMatchObject({
      method: "POST",
      route: "/__vitehub/chat/devtools",
    })
    expect(nitro.options.alias["@vitehub/chat"]).toContain("/packages/chat/src/index.ts")
    expect(nitro.options.alias["@vitehub/chat/nitro"]).toContain("/packages/chat/src/nitro.ts")
    expect(nitro.options.alias["@vitehub/chat/runtime/nitro-runtime-config"]).toContain("/packages/chat/src/runtime/nitro-runtime-config.ts")
    expect(nitro.options.plugins.some(plugin => plugin.includes("/packages/chat/src/runtime/nitro-plugin.ts"))).toBe(true)
    expect(nitro.options.externals.inline).toEqual(expect.arrayContaining(["@vitehub/chat", "chat", "chat-state-cloudflare-do"]))
    expect(JSON.stringify(nitro.options.imports)).toContain("defineChat")
    expect(JSON.stringify(nitro.options.imports)).toContain("defineChatDevInitializer")
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
    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      cloudflare: {
        durableObjectState: {
          name: "default",
        },
      },
    })
    const plugin = getChatCloudflareExportsPlugin(nitro, "ChatStateDO")
    expect(plugin).toBeTruthy()
    const resolvedModuleId = plugin!.resolveId("virtual:vitehub-chat-cloudflare-exports:ChatStateDO")
    expect(resolvedModuleId).toBe("\0virtual:vitehub-chat-cloudflare-exports:ChatStateDO")
    expect(plugin!.load(resolvedModuleId!)).toContain(`export { ChatStateDO } from "chat-state-cloudflare-do"`)
    expect(plugin!.renderChunk("const server = true", { fileName: "index.mjs", isEntry: true })?.code)
      .toContain(`export { ChatStateDO } from "./chat-cloudflare-exports-ChatStateDO.mjs"`)
    await nitro.testHooks["build:before"]?.[0]?.()
    expect(nitro.options.rollupConfig.plugins?.filter(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === "vitehub-chat-cloudflare-exports:ChatStateDO")).toHaveLength(1)

    const typesHook = nitro.testHooks["types:extend"]?.[0]
    const tsConfig = { include: [] as string[] }
    await typesHook?.({ tsConfig })
    const types = await readFile(join(rootDir, ".nitro/types/vitehub-chat.d.ts"), "utf8")
    expect(types).toContain(`import "@vitehub/chat/nitro"`)
    expect(tsConfig.include).toContain(join(rootDir, ".nitro/types/vitehub-chat.d.ts"))

    const routeFile = nitro.options.handlers[0]!.handler
    const routeContents = await readFile(routeFile, "utf8")
    expect(routeContents).toContain("defineChatWebhookHandler(chat")
    expect(routeContents).toContain("inferredName: \"chat\"")
    const devInitializerFile = nitro.options.alias["@vitehub/chat/runtime/nitro-dev-initialize"]
    expect(devInitializerFile).toContain("/.nitro/.vitehub/nitro-runtime/chat/dev-initialize.mjs")
    const devInitializerContents = await readFile(devInitializerFile, "utf8")
    expect(devInitializerContents).toContain("defineChatDevInitializer(chat")
    expect(devInitializerContents).toContain("inferredName: \"chat\"")
    const devtoolsContents = await readFile(nitro.options.handlers[1]!.handler, "utf8")
    expect(devtoolsContents).toContain("defineChatDevtoolsHandler(chat")
    expect(devtoolsContents).toContain("inferredName: \"chat\"")
  })

  it("keeps the default Nitro runtime config reader when the env Nitro module is installed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-env-"))
    await writeSingleChat(rootDir, [
      `export default defineChat({ state: {}, adapters: {} })`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    nitro.options.alias["#vitehub/env/server"] = "/virtual/vitehub-env-server"
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    const runtimeConfigBridge = nitro.options.alias["@vitehub/chat/runtime/nitro-runtime-config"]
    expect(runtimeConfigBridge).toContain("/packages/chat/src/runtime/nitro-runtime-config.ts")
  })

  it("honors custom Cloudflare DO config discovered from the chat definition", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-custom-do-"))
    await writeSingleChat(rootDir, [
      `import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"`,
      `export default defineChat({`,
      `  adapters: {},`,
      `  state: cloudflareDurableObjectState({ binding: "CUSTOM_STATE", className: "CustomChatStateDO", migrationTag: "v2" }),`,
      `})`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.cloudflare).toMatchObject({
      wrangler: {
        durable_objects: {
          bindings: [{ class_name: "CustomChatStateDO", name: "CUSTOM_STATE" }],
        },
        migrations: [{ new_sqlite_classes: ["CustomChatStateDO"], tag: "v2" }],
      },
    })
    const plugin = getChatCloudflareExportsPlugin(nitro, "CustomChatStateDO")
    expect(plugin).toBeTruthy()
    const resolvedModuleId = plugin!.resolveId("virtual:vitehub-chat-cloudflare-exports:CustomChatStateDO")
    expect(plugin!.load(resolvedModuleId!)).toContain(`export { ChatStateDO as CustomChatStateDO } from "chat-state-cloudflare-do"`)
  })

  it("does not use cloudflare.wrangler.name as the default Durable Object state name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-wrangler-name-"))
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "package-chat" }), "utf8")
    await writeSingleChat(rootDir, [
      `import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"`,
      `export default defineChat({ state: cloudflareDurableObjectState(), adapters: {} })`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    nitro.options.cloudflare = {
      wrangler: {
        name: "wrangler-chat",
      },
    }
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      cloudflare: {
        durableObjectState: {
          name: "package-chat",
        },
      },
    })
  })

  it("uses package.json name as the default Cloudflare Worker name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-worker-name-"))
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "@acme/package-chat" }), "utf8")
    await writeSingleChat(rootDir, [
      `import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"`,
      `export default defineChat({ state: cloudflareDurableObjectState(), adapters: {} })`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.cloudflare?.wrangler?.name).toBe("acme-package-chat")
  })

  it("falls back to package.json name as the default Durable Object state name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-package-name-"))
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "package-chat" }), "utf8")
    await writeSingleChat(rootDir, [
      `import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"`,
      `export default defineChat({ state: cloudflareDurableObjectState(), adapters: {} })`,
    ].join("\n"))
    const nitro = createNitroStub(rootDir)
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      cloudflare: {
        durableObjectState: {
          name: "package-chat",
        },
      },
    })
  })

  it("does not infer Cloudflare DO config for non-Cloudflare providers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-nitro-provider-"))
    await writeSingleChat(rootDir, `cloudflareDurableObjectState()`)
    const nitro = createNitroStub(rootDir, { provider: "nitro" })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.cloudflare).toBeUndefined()
    expect(getChatCloudflareExportsPlugin(nitro, "ChatStateDO")).toBeUndefined()
  })

  it("does not install a Cloudflare entrypoint when Durable Object state is disabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-disabled-do-"))
    await writeSingleChat(rootDir)
    const nitro = createNitroStub(rootDir, {
      cloudflare: {
        durableObjectState: false,
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(getChatCloudflareExportsPlugin(nitro, "ChatStateDO")).toBeUndefined()
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

    expect(nitro.options.handlers).toHaveLength(1)
    expect(nitro.options.handlers[0]).toMatchObject({
      method: "POST",
      route: "/__vitehub/chat/devtools",
    })
    expect(nitro.options.imports).toEqual({})
    expect(nitro.options.plugins.some(plugin => plugin.includes("/packages/chat/src/runtime/nitro-plugin.ts"))).toBe(true)
  })

  it("does not install DevTools routes outside Nitro dev", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-production-devtools-"))
    await writeSingleChat(rootDir)
    const nitro = createNitroStub(rootDir)
    nitro.options.dev = false
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      dev: {
        devtools: false,
        initialize: true,
        localStateFallback: true,
      },
    })
    expect(nitro.options.handlers.some(handler => handler.route === "/__vitehub/chat/devtools")).toBe(false)
  })

  it("honors disabled dev initialization", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-disabled-dev-"))
    await writeSingleChat(rootDir)
    const nitro = createNitroStub(rootDir, {
      dev: { initialize: false },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      dev: {
        devtools: false,
        initialize: false,
        localStateFallback: true,
      },
    })
    expect(nitro.options.alias["@vitehub/chat/runtime/nitro-dev-initialize"]).toContain("/packages/chat/src/runtime/nitro-dev-initialize.ts")
    expect(nitro.options.handlers.some(handler => handler.route === "/__vitehub/chat/devtools")).toBe(false)
  })

  it("honors disabled devtools", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-chat-disabled-devtools-"))
    await writeSingleChat(rootDir)
    const nitro = createNitroStub(rootDir, {
      dev: { devtools: false },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig.chat).toMatchObject({
      dev: {
        devtools: false,
        initialize: true,
        localStateFallback: true,
      },
    })
    expect(nitro.options.handlers.some(handler => handler.route === "/__vitehub/chat/devtools")).toBe(false)
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
    expect(await readFile(nitro.options.alias["@vitehub/chat/runtime/nitro-dev-initialize"], "utf8")).toContain("defineChatDevRegistryInitializer")
    expect(await readFile(nitro.options.handlers[1]!.handler, "utf8")).toContain("defineChatDevtoolsRegistryHandler")
  })
})
