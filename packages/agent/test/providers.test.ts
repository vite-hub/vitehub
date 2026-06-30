import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Message } from "chat"
import { describe, expect, it, vi } from "vitest"

import type { AgentChannelChatRouteStandardSchemaV1 } from "../src/server.ts"
import type { Adapter, ChatInstance, StreamChunk, WebhookOptions } from "chat"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

vi.mock("@vite-hub/internal/build/deployment-output", () => ({
  writeProviderDeploymentOutputs: vi.fn(async () => undefined),
}))

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

function githubSignature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function createTestChatAdapter(options: { deferMessageProcessing?: boolean, missingIncomingMessageId?: boolean, persistThreadHistory?: boolean, secret?: string } = {}) {
  let chatInstance: ChatInstance | undefined
  let sentMessageId = 0
  const cachedMessages = new Map<string, Message[]>()
  const cacheMessage = (message: Message) => {
    cachedMessages.set(message.threadId, [...(cachedMessages.get(message.threadId) ?? []), message])
  }
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
      const from = rawMessage.from as { email?: string, id?: number | string, mail?: string, userPrincipalName?: string, username?: string } | undefined
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
          ...(from?.email ? { email: from.email } : {}),
          ...(from?.mail ? { mail: from.mail } : {}),
          ...(from?.userPrincipalName ? { userPrincipalName: from.userPrincipalName } : {}),
          isBot: false,
          isMe: false,
          userId: String(from?.id ?? "123"),
          userName: String(from?.username ?? "maxi"),
        },
        formatted: { children: [], type: "root" },
        id: options.missingIncomingMessageId ? undefined as unknown as string : String(rawMessage.message_id ?? "7"),
        metadata: { dateSent: date, edited: false },
        raw: body,
        text: typeof rawMessage.text === "string" ? rawMessage.text : "",
        threadId: `telegram:${String(chat?.id ?? "456")}`,
      })
      cacheMessage(message)
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
    fetchMessages: vi.fn(async (threadId: string) => ({ messages: cachedMessages.get(threadId) ?? [] })),
    name: "telegram",
    persistThreadHistory: options.persistThreadHistory,
    postMessage: vi.fn(async (threadId: string, message: unknown) => {
      const id = `sent-${++sentMessageId}`
      cacheMessage(new Message({
        attachments: [],
        author: {
          fullName: "vitehub",
          isBot: true,
          isMe: true,
          userId: "self",
          userName: "vitehub",
        },
        formatted: { children: [], type: "root" },
        id,
        metadata: { dateSent: new Date("2026-06-10T12:00:00.000Z"), edited: false },
        raw: { message },
        text: typeof message === "string"
          ? message
          : typeof message === "object" && message && "markdown" in message && typeof message.markdown === "string"
            ? message.markdown
            : "",
        threadId,
      }))
      return { id, raw: { message }, threadId }
    }),
    startTyping: vi.fn(async () => {}),
    userName: "vitehub",
  }
  return adapter as unknown as Adapter & {
    handleWebhook: ReturnType<typeof vi.fn>
    editMessage: ReturnType<typeof vi.fn>
    fetchMessages: ReturnType<typeof vi.fn>
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
    const plugin = hubAgent({ routes: { chat: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({ agent: { routes: { chat: true } } })
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

  it("writes Netlify provider output for generated agent HTTP routes", async () => {
    const { writeProviderDeploymentOutputs } = await import("@vite-hub/internal/build/deployment-output")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-netlify-routes-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    const previousNetlify = process.env.NETLIFY
    try {
      process.env.VITEHUB_HOSTING = "netlify"
      delete process.env.NETLIFY
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true, webhooks: true } })
      const configResolved = plugin.configResolved as (config: { build?: { outDir?: string }, command: "build", resolve: { alias: Array<{ find: string, replacement: string }> }, root: string }) => Promise<void>
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
      vi.mocked(writeProviderDeploymentOutputs).mockClear()

      await configResolved({
        build: { outDir: "dist/client" },
        command: "build",
        resolve: { alias: [{ find: "#support", replacement: join(root, "support.ts") }] },
        root,
      })
      await closeBundle.handler()

      const wrapper = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
      expect(wrapper).toContain("export default async function viteHubAgentNetlifyFunction(request, context)")
      expect(wrapper).toContain("import { createChannelChatRouteHandler, createChannelWebhookRouteHandler } from \"@vite-hub/agent/server/internal\"")
      expect(wrapper).toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/agent/server/workspace\"")
      expect(wrapper).not.toContain("@vite-hub/workspace/internal/runtime/state")
      expect(wrapper).toContain("process.env.VITEHUB_HOSTING = 'netlify'")
      expect(wrapper).toContain("const waitUntil = waitUntilFromContext(context)")
      expect(wrapper).toContain("const webhook = netlifyParam(context, 'webhook')")
      expect(wrapper).not.toContain("runtime: 'vite'")
      expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith({
        clientOutDir: "dist/client",
        netlify: {
          functions: [{
            bundleEntry: join(root, ".vitehub/agent/netlify-function.mjs"),
            bundleOptions: {
              alias: { "#support": join(root, "support.ts") },
              external: [
                "@ai-sdk/harness",
                "@ai-sdk/harness/*",
                "@ai-sdk/mcp",
                "@ai-sdk/sandbox-vercel",
                "@modelcontextprotocol/sdk/*",
                "@vite-hub/sandbox",
                "@vite-hub/sandbox/*",
                "@vite-hub/shell",
                "@vite-hub/shell/*",
                "@vite-hub/workflow",
                "@vite-hub/workflow/*",
                "agents",
                "evalite/*",
                "vitest/*",
              ],
              format: "esm",
              platform: "node",
            },
            config: {
              name: "vitehub-agent",
              nodeBundler: "esbuild",
              path: ["/api/_vitehub/agents/:agent/chat", "/api/_vitehub/agents/:agent/webhooks/:webhook"],
            },
            functionName: "vitehub-agent",
          }],
        },
        rootDir: root,
      })
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
      if (typeof previousNetlify === "string") process.env.NETLIFY = previousNetlify
      else delete process.env.NETLIFY
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes Netlify provider output during Netlify local dev", async () => {
    const { writeProviderDeploymentOutputs } = await import("@vite-hub/internal/build/deployment-output")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-netlify-dev-routes-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    const previousNetlifyDev = process.env.NETLIFY_DEV
    try {
      delete process.env.VITEHUB_HOSTING
      process.env.NETLIFY_DEV = "true"
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true } })
      const configResolved = plugin.configResolved as (config: { build?: { outDir?: string }, command: "serve", resolve: { alias: Array<{ find: string, replacement: string }> }, root: string }) => Promise<void>
      vi.mocked(writeProviderDeploymentOutputs).mockClear()

      await configResolved({
        build: { outDir: "dist/client" },
        command: "serve",
        resolve: { alias: [] },
        root,
      })

      const wrapper = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
      expect(wrapper).toContain("handler(request, webhook, { agentName: agent, runtime: 'vite', waitUntil })")
      expect(wrapper).toContain("handler(request, { agentName: agent, runtime: 'vite', waitUntil })")
      expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith(expect.objectContaining({
        netlify: expect.objectContaining({
          functions: [expect.objectContaining({
            config: expect.objectContaining({
              path: "/api/_vitehub/agents/:agent/chat",
            }),
            functionName: "vitehub-agent",
          })],
        }),
        rootDir: root,
      }))
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
      if (typeof previousNetlifyDev === "string") process.env.NETLIFY_DEV = previousNetlifyDev
      else delete process.env.NETLIFY_DEV
      await rm(root, { force: true, recursive: true })
    }
  })

  it("cleans stale Netlify agent output when generated routes are disabled", async () => {
    const { writeProviderDeploymentOutputs } = await import("@vite-hub/internal/build/deployment-output")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-netlify-cleanup-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    try {
      process.env.VITEHUB_HOSTING = "netlify"
      const plugin = hubAgent({ routes: { chat: false, webhooks: false } })
      const configResolved = plugin.configResolved as unknown as (config: { build?: { outDir?: string }, command: "build", resolve: { alias: [] }, root: string }) => Promise<void>
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
      vi.mocked(writeProviderDeploymentOutputs).mockClear()

      await configResolved({
        build: { outDir: "dist/client" },
        command: "build",
        resolve: { alias: [] },
        root,
      })
      await closeBundle.handler()

      expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith({
        cleanup: {
          netlify: {
            functionNames: ["vitehub-agent"],
          },
        },
        clientOutDir: "dist/client",
        rootDir: root,
      })
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers configured agent webhook routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { webhooks: true } })
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

  it("registers configured agent chat routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { chat: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: [{
          handler: ".vitehub/agent/chat-webhook-route.ts",
          route: "/api/_vitehub/agents/:agent/chat",
        }],
      },
    })
  })

  it("installs Cloudflare chat state bindings for generated webhook routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { webhooks: true } })
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
    const plugin = hubAgent({ providers: { state: { provider: "memory" } }, routes: { chat: true, webhooks: true } })
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
      route: "/api/_vitehub/agents/:agent/chat",
    })
    expect(output.nitro?.handlers).toContainEqual({
      handler: ".vitehub/agent/chat-webhook-route.ts",
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    })
    expect(output.nitro?.cloudflare).toBeUndefined()
    expect(output.nitro?.rollupConfig).toBeUndefined()
    expect(output.build).toBeUndefined()
  })

  it("skips Nitro handlers for Deno generated output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { chat: true, webhooks: true }, runtime: "deno" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      agent: { routes: { chat: true, webhooks: true }, runtime: "deno" },
      server: { watch: { ignored: ["**/.vitehub/**"] } },
    })
    expect((result as { nitro?: unknown } | undefined)?.nitro).toBeUndefined()
  })

  it("does not materialize Vercel runtime packages for Deno output", async () => {
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-close-bundle-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ eval: false, routes: { chat: true }, runtime: "deno" })
      const configResolved = plugin.configResolved as (config: { agent?: unknown, command: "build", root: string }) => Promise<void>
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
      vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

      await configResolved({ agent: { eval: false, routes: { chat: true }, runtime: "deno" }, command: "build", root })
      await closeBundle.handler()

      expect(copyVercelFunctionRuntimePackages).not.toHaveBeenCalled()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes generated Nitro handlers that pass Web Requests to chat webhooks", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-routes-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true, webhooks: true } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "serve", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("createChannelChatRouteHandler")
      expect(webhookRoute).toContain("withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule")
      expect(webhookRoute).toContain("import { createCloudflareAgentState } from \"@vite-hub/agent/cloudflare\"")
      expect(webhookRoute).toContain("async function toRequest(event)")
      expect(webhookRoute).toContain("const body = await readRawBody(event)")
      expect(webhookRoute).not.toContain("return event.request")
      expect(webhookRoute).toContain("function waitUntilFromEvent(event)")
      expect(webhookRoute).toContain("function chatStateFromCloudflare(cloudflare)")
      expect(webhookRoute).toContain("function resolveChatRouteOptions(module)")
      expect(webhookRoute).toContain("waitUntil: waitUntilFromEvent(event)")
      expect(webhookRoute).toContain("state: chatStateFromCloudflare(cloudflare)")
      expect(webhookRoute).toContain("runtime: 'vite'")
      expect(webhookRoute).toContain("const agentModules")
      expect(webhookRoute).toContain("const chatHandlers")
      expect(webhookRoute).toContain("createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))")
      expect(webhookRoute).toContain("const webhookHandlers")
      expect(webhookRoute).toContain("const webhookRoutePattern")
      expect(webhookRoute).toContain("const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)")
      expect(webhookRoute).toContain("return isWebhookRoute ? await handler(await toRequest(event), webhook")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("lets built generated Nitro handlers detect the host runtime", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-routes-build-runtime-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true, webhooks: true } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).not.toContain("runtime: 'vite'")
      expect(webhookRoute).toContain("return isWebhookRoute ? await handler(await toRequest(event), webhook, { agentName: agent, cloudflare, state: chatStateFromCloudflare(cloudflare), waitUntil: waitUntilFromEvent(event) }) : await handler(await toRequest(event), { agentName: agent, cloudflare, waitUntil: waitUntilFromEvent(event) })")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs hosted workspace runtime setup for GitHub-backed Agent workspaces", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-hosted-workspace-route-"))
    try {
      await mkdir(join(root, "server", "agents", "audio-bitacora"), { recursive: true })
      await writeFile(join(root, "server", "agents", "audio-bitacora", "config.ts"), [
        "import { defineAgent } from '@vite-hub/agent'",
        "export default defineAgent({",
        "  workspace: {",
        "    mode: 'write',",
        "    store: {",
        "      branch: 'main',",
        "      provider: 'github',",
        "      repository: 'onmax/bitacora-de-vida',",
        "      root: '/',",
        "    },",
        "  },",
        "  async run() { return 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      const plugin = hubAgent({ routes: { chat: true, webhooks: true } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("import { installHostedWorkspaceRuntime } from \"@vite-hub/workspace/hosted\"")
      expect(webhookRoute).toContain("function hasHostedWorkspaceStore(module)")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()")
      expect(webhookRoute).toContain("setWorkspaceRuntimeRegistry(Object.fromEntries([")
      expect(webhookRoute).toContain("workspaceRegistryEntry(\"audio-bitacora\", agent0")
      expect(webhookRoute).not.toContain("@vite-hub/workspace/internal/stores/github")
      expect(webhookRoute).not.toContain("configureCloudflareWorkspaceRuntime")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes generated Deno server output for chat and webhook routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-routes-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true, webhooks: true }, runtime: "deno" })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")

      expect(denoServer).toContain("import { createChannelChatRouteHandler, createChannelWebhookRouteHandler } from \"@vite-hub/agent/server/internal\"")
      expect(denoServer).not.toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/workspace/runtime\"")
      expect(denoServer).toContain("await import('../schedule/deno-cron.mjs').catch")
      expect(denoServer).toContain("const chatRoutePattern = new RegExp(\"^/api/_vitehub/agents/(?<agent>[^/]+)/chat$\")")
      expect(denoServer).toContain("const webhookRoutePattern = new RegExp(\"^/api/_vitehub/agents/(?<agent>[^/]+)/webhooks/(?<webhook>[^/]+)$\")")
      expect(denoServer).toContain("return isWebhookRoute ? await handler(request, webhook, { agentName: agent }) : await handler(request, { agentName: agent })")
      expect(denoServer).toContain("function resolveDenoServeOptions(args)")
      expect(denoServer).toContain("const serveOptions = resolveDenoServeOptions(Deno.args)")
      expect(denoServer).toContain("Deno.serve(serveOptions, handleRequest)")
      expect(denoServer).toContain("Deno.serve(handleRequest)")
      expect(denoServer).not.toContain("export default")
      expect(denoServer).not.toContain("@vite-hub/workspace/internal")
      expect(denoServer).not.toContain("/Users/maxi/.codex/worktrees/9506/vitehub")
      expect(denoServer).not.toContain("@/")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers workspace-backed Agent Definitions in Deno server output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-workspace-routes-"))
    try {
      await mkdir(join(root, "server", "agents", "support", "workspace"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support", "config.ts"), [
        "import { defineAgent } from '@vite-hub/agent'",
        "import { skills } from '@vite-hub/agent/capabilities'",
        "export default defineAgent({",
        "  capabilities: [skills({",
        "    path: 'skills/agent-browser',",
        "    source: { content: '# Browser\\n', workspacePath: 'SKILL.md' },",
        "    sourceKey: 'agentBrowserSkill',",
        "  })],",
        "  workspace: {},",
        "  async run() { return 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      await writeFile(join(root, "server", "agents", "support", "instructions.md"), "Use support instructions.\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "workspace", "instructions.md"), "Do not use workspace instructions.\n", "utf8")
      const plugin = hubAgent({ routes: { chat: true }, runtime: "deno" })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")

      expect(denoServer).toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/workspace/runtime\"")
      expect(denoServer).toContain("workspaceAgentOwnsWorkspaceDefinition")
      expect(denoServer).toContain("withWorkspaceSourceRoot(resolveAgentModule(agent0)")
      expect(denoServer).toContain("workspaceRegistryEntry(\"support\", agent0")
      expect(denoServer).toContain("__vitehubAgentInstructions")
      expect(denoServer).toContain("content: colocatedInstructions")
      expect(denoServer).toContain("const existingSources = agent.sources && typeof agent.sources === 'object' ? agent.sources : undefined")
      expect(denoServer).toContain("    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }")
      expect(denoServer).toContain("workspaceDefinitionFromOptions")
      expect(denoServer).toContain("const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }")
      expect(denoServer).toContain("return { ...agent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }")
      expect(denoServer).toContain(`${JSON.stringify(join(root, "server", "agents", "support", "workspace"))}, "Use support instructions.\\n")`)
      expect(denoServer).not.toContain("Do not use workspace instructions.")
      expect(denoServer).toContain("setWorkspaceRuntimeRegistry(Object.fromEntries([")
      expect(denoServer).not.toContain("\"support\": async ()")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes generated Nitro webhook handlers for direct single-agent webhook routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-direct-webhook-route-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { webhooks: "/api/github/webhook" } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("const webhookRoutePattern = new RegExp(\"^/api/github/webhook$\")")
      expect(webhookRoute).toContain("const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)")
      expect(webhookRoute).toContain("const webhook = ''")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("publishes the Cloudflare state Durable Object subpath", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>
    }

    expect(pkg.exports?.["./cloudflare/state"]).toEqual({
      types: "./dist/cloudflare/state.d.ts",
      import: "./dist/cloudflare/state.js",
    })
  })

  it("publishes the internal generated Agent route handler subpath", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>
    }

    expect(pkg.exports?.["./server/internal"]).toEqual({
      types: "./dist/server/internal.d.ts",
      import: "./dist/server/internal.js",
    })
  })

  it("keeps esbuild external in the Agent Vite plugin package build", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8")
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
    }

    expect(config).toContain('"esbuild"')
    expect(pkg.dependencies?.esbuild).toBe("catalog:esbuild-v27")
  })

  it("does not publish subpath-only integrations as root peers", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    const distDir = new URL("../dist/", import.meta.url)
    const builtJs = (await Promise.all((await readdir(distDir))
      .filter(file => file.endsWith(".js"))
      .map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
      + "\n"
      + await readFile(new URL("../dist/runtime/workflow.js", import.meta.url), "utf8")

    expect(pkg.peerDependencies?.agents).toBeUndefined()
    expect(pkg.peerDependencies?.["@vite-hub/workflow"]).toBeUndefined()
    expect(pkg.peerDependencies?.evalite).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.agents).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.["@vite-hub/workflow"]).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.evalite).toBeUndefined()
    expect(pkg.peerDependencies?.ai).toBe("catalog:ai-compat")
    expect(pkg.dependencies?.["@types/json-schema"]).toBe("catalog:ai")
    expect(builtJs).not.toContain("import(\"@vite-hub/workflow\")")
    expect(builtJs).not.toContain("import('@vite-hub/workflow')")
    expect(builtJs).not.toContain("import(\"@vite-hub/workflow/runtime/state\")")
    expect(builtJs).not.toContain("import('@vite-hub/workflow/runtime/state')")
    expect(builtJs).toContain("@vite-hub/workflow")
  })

  it("publishes the Agent output helper subpath", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>
    }

    expect(pkg.exports?.["./output"]).toEqual({
      types: "./dist/output.d.ts",
      import: "./dist/output.js",
    })
  })
})

describe("server helpers", () => {
  it("registers workspace agents for app-owned routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-runtime-workspace-"))
    const sourceRoot = join(root, "support", "workspace")
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, "AGENTS.md"), "# Support\n")

    try {
      const { defineAgent } = await import("../src/index.ts")
      const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
      const { defineWorkspace, file, useWorkspace } = await import("@vite-hub/workspace")
      const agent = defineAgent({
        driver: { async run() {
            return "ok"
          } },
        workspace: defineWorkspace({
          store: { provider: "memory" },
          sources: {
            instructions: file("AGENTS.md"),
          },
        }),
      })

      const preparedAgent = registerWorkspaceAgent(agent, {
        sourceRootDir: sourceRoot,
        workspace: "support-runtime",
      })
      const workspace = useWorkspace("support-runtime")

      expect(preparedAgent.__vitehubWorkspaceAgentDefaults?.workspace).toBe("support-runtime")
      expect(preparedAgent.sourceRootDir).toBe(sourceRoot)
      expect((preparedAgent.__vitehubWorkspaceAgentOptions.workspace as { sourceRootDir?: string }).sourceRootDir).toBe(sourceRoot)
      expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Support\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not shadow named workspace references", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-runtime-workspace-"))
    const sourceRoot = join(root, "registered", "workspace")
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, "AGENTS.md"), "# Registered\n")

    try {
      const { defineAgent } = await import("../src/index.ts")
      const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
      const { defineWorkspace, file, useWorkspace } = await import("@vite-hub/workspace")
      const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
      const workspaceName = "support-runtime-named-reference"
      registerWorkspace(workspaceName, defineWorkspace({
        sourceRootDir: sourceRoot,
        store: { provider: "memory" },
        sources: {
          instructions: file("AGENTS.md"),
        },
      }))
      const agent = defineAgent({
        driver: { async run() {
            return "ok"
          } },
        workspace: workspaceName,
      })

      const preparedAgent = registerWorkspaceAgent(agent, {
        sourceRootDir: join(root, "ignored", "workspace"),
      })
      const workspace = useWorkspace(workspaceName)

      expect(preparedAgent.__vitehubWorkspaceAgentOptions.workspace).toBe(workspaceName)
      expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Registered\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not register object workspace references as definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-runtime-workspace-"))
    const sourceRoot = join(root, "registered", "workspace")
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, "AGENTS.md"), "# Registered\n")

    try {
      const { defineAgent } = await import("../src/index.ts")
      const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
      const { defineWorkspace, file, useWorkspace } = await import("@vite-hub/workspace")
      const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
      const workspaceName = "support-runtime-object-reference"
      registerWorkspace(workspaceName, defineWorkspace({
        sourceRootDir: sourceRoot,
        store: { provider: "memory" },
        sources: {
          instructions: file("AGENTS.md"),
        },
      }))
      const agent = defineAgent({
        driver: { async run() {
            return "ok"
          } },
        workspace: { mode: "write", name: workspaceName },
      })

      const preparedAgent = registerWorkspaceAgent(agent, {
        sourceRootDir: join(root, "ignored", "workspace"),
      })
      const workspace = useWorkspace(workspaceName)

      expect(preparedAgent.__vitehubWorkspaceAgentOptions.workspace).toEqual({ mode: "write", name: workspaceName })
      expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Registered\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serves hosted Chat DevTools state for an explicit agent handler", async () => {
    const { defineAgent, defineAgentInvoker } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelDevtoolsRouteHandler } = await import("../src/server/internal.ts")
    const { custom, defineWorkspace } = await import("@vite-hub/workspace")
    const profiles: Array<{ id: string, kind?: string, meta?: Record<string, unknown> }> = [{
      id: "customer:demo:support",
      kind: "customerPortal",
      meta: { customer: "demo" },
    }]
    const runtimeEvents: string[] = []
    const agent = defineAgent({
      capabilities: [
        defineChatCapability(),
      ],
      invoker: defineAgentInvoker({
        profiles,
      }),
      driver: { run: ({ runtime }) => {
        runtimeEvents.push(`run:${runtime}`)
        return `devtools on ${runtime}`
      } },
      version: "test-agent",
      workspace: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          docs: custom({
            materialize: "lazy",
            mount: "docs",
            async getKeys() {
              return ["README.md"]
            },
            async getItem(key) {
              return { content: "# Support\n", key }
            },
          }),
        },
      }),
    })
    const handler = createChannelDevtoolsRouteHandler(agent as never, {
      name: "support",
      runtime: "vite",
    })

    const response = await handler(new Request("https://example.com/__vitehub/agent/chat/devtools", {
      body: JSON.stringify({
        action: "get-state",
        invokerProfileId: "customer:demo:support",
        meta: { email: "user@example.com" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    await expect(response.json()).resolves.toMatchObject({
      chats: [{
        invokerProfileId: "customer:demo:support",
        name: "support",
        title: "support",
        uiMessages: [],
      }],
      invokerProfileId: "customer:demo:support",
      invokerProfiles: [{
        id: "customer:demo:support",
        kind: "customerPortal",
        meta: { customer: "demo" },
      }],
      meta: { email: "user@example.com" },
      metadataStatus: "ready",
      selected: "support",
      title: "support",
      uiMessages: [],
      version: "test-agent",
    })

    runtimeEvents.length = 0
    const materializedResponse = await handler(new Request("https://example.com/__vitehub/agent/chat/devtools", {
      body: JSON.stringify({
        action: "materialize-source",
        invokerProfileId: "customer:demo:support",
        path: "docs",
        source: "docs",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(materializedResponse.status).toBe(200)
    await expect(materializedResponse.json()).resolves.toMatchObject({
      chats: [{
        name: "support",
        title: "support",
      }],
      title: "support",
    })

    runtimeEvents.length = 0
    const sendResponse = await handler(new Request("https://example.com/__vitehub/agent/chat/devtools", {
      body: JSON.stringify({
        action: "send",
        invokerProfileId: "customer:demo:support",
        stream: true,
        text: "hello",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(sendResponse.status).toBe(200)
    expect(await sendResponse.text()).toContain("devtools on vite")
    expect(runtimeEvents).toContain("run:vite")
  })

  it("threads hosted Chat DevTools runtime overrides through metadata resolution", async () => {
    const { defineAgent, defineAgentInvoker } = await import("../src/index.ts")
    const { createChannelDevtoolsRouteHandler } = await import("../src/server/internal.ts")
    const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
    const { custom, defineWorkspace } = await import("@vite-hub/workspace")
    const runtimeEvents: string[] = []
    const agent = registerWorkspaceAgent(defineAgent({
      driver: { run: () => "unused" },
      invoker: defineAgentInvoker({
        resolve({ defaultInvoker, runtime }) {
          runtimeEvents.push(`metadata:${runtime}`)
          return defaultInvoker
        },
      }),
      workspace: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          docs: custom({
            materialize: "lazy",
            mount: "docs",
            async getKeys() {
              return ["README.md"]
            },
            async getItem(key) {
              return { content: "# Support\n", key }
            },
          }),
        },
      }),
    }), { workspace: "support-devtools-runtime-override" })
    const handler = createChannelDevtoolsRouteHandler(agent as never, {
      name: "support",
      runtime: "vite",
    })

    const response = await handler(new Request("https://example.com/__vitehub/agent/chat/devtools", {
      body: JSON.stringify({
        action: "materialize-source",
        path: "docs",
        source: "docs",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(200)
    expect(runtimeEvents).toContain("metadata:vite")
  })

  it("serves AI SDK UI message chat requests through the chat trigger", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const resolveInvoker = vi.fn(({ defaultInvoker, request }) => ({
      id: `customer:${request.headers.get("x-customer")}`,
      kind: "customer",
      meta: {
        fallback: defaultInvoker.id,
        user: request.headers.get("x-user"),
      },
    }))
    const run = vi.fn(({ context, invoker, messages, run, runtime }) => {
      const text = messages[0]?.parts.find((part: { type?: string }) => part.type === "text") as { text?: string } | undefined
      return `echo ${text?.text} for ${invoker.id} via ${run.origin} on ${runtime} from ${invoker.meta.user} after ${invoker.meta.fallback}`
    })
    const agent = defineAgent({
      capabilities: [defineChatCapability()],
      invoker: { resolve: resolveInvoker },
      driver: {
        run
      },
    })
    const handler = createChannelChatRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }),
      headers: {
        "content-type": "application/json",
        "x-customer": "acme",
        "x-user": "portal-user",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    await expect(response.text()).resolves.toContain("echo hello for customer:acme via http on unknown from portal-user after anonymous:http")
    expect(resolveInvoker).toHaveBeenCalledWith(expect.objectContaining({
      defaultInvoker: expect.objectContaining({
        id: "anonymous:http",
        kind: "anonymous",
      }),
      request: expect.any(Request),
      run: expect.objectContaining({
        channelId: "http:support",
        origin: "http",
        threadId: "http:support:portal-thread",
      }),
    }))
  })

  it("leaves custom text/event-stream chat Response bodies unchanged", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: {
        run: () => new Response("event: custom\ndata: ok\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentName: "support" })

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBeNull()
    await expect(response.text()).resolves.toBe("event: custom\ndata: ok\n\n")
  })

  it("appends DONE to UI message chat Response bodies and drops stale body headers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: {
        run: () => new Response("data: {\"type\":\"finish\"}\n\n", {
          headers: {
            "content-encoding": "gzip",
            "content-length": "24",
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        }),
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentName: "support" })

    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("content-encoding")).toBeNull()
    await expect(response.text()).resolves.toBe("data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n")
  })

  it("appends DONE when UI message content mentions the DONE frame", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: {
        run: () => new Response("data: {\"type\":\"text-delta\",\"text\":\"data: [DONE]\"}\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        }),
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentName: "support" })

    await expect(response.text()).resolves.toBe("data: {\"type\":\"text-delta\",\"text\":\"data: [DONE]\"}\n\ndata: [DONE]\n\n")
  })

  it("propagates partial UI message chat Response read failures", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const encoder = new TextEncoder()
    const error = new Error("upstream failed")
    let read = false
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: {
        run: () => new Response(new ReadableStream({
          pull(controller) {
            if (read) throw error
            read = true
            controller.enqueue(encoder.encode("data: {\"type\":\"text-delta\",\"text\":\"partial\"}\n\n"))
          },
        }), {
          headers: {
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        }),
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentName: "support" })

    await expect(response.text()).rejects.toThrow("upstream failed")
  })

  it("serves stream Channel chat routes with channel-owned trusted input mapping", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { stream } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context, invoker, run }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, user?: { email?: string } } | undefined
      return `portal ${run.channelId} ${run.origin} ${run.threadId} ${invoker.id} ${chatContext?.user?.email} ${chatContext?.meta?.audience}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: stream({
          route: {
            mapInput({ body, request }) {
              if (request.headers.get("x-quiver-chat-token") !== "trusted") {
                throw new Error("Invalid Quiver Chat token.")
              }
              return {
                invokerProfileId: "customer:acme",
                meta: body.meta as Record<string, unknown>,
                run: { origin: "portal" },
                user: body.user as Record<string, unknown>,
              }
            },
          },
        }),
      },
      invoker: {
        profiles: [{
          id: "customer:acme",
          kind: "customerPortal",
          meta: { scope: "acme" },
        }],
      },
      driver: {
        run
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical", customer: "acme", source: "portal" },
        user: { email: "user@example.com" },
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    await expect(response.text()).resolves.toContain("portal portal portal portal:portal-thread customer:acme user@example.com technical")
    expect(run).toHaveBeenCalled()
  })

  it("serves webChat routes with admission callbacks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    type PortalBody = {
      id?: string
      messages: unknown[]
      meta: Record<string, unknown>
      user: Record<string, unknown>
    }
    const bodySchema: AgentChannelChatRouteStandardSchemaV1<PortalBody> = {
      "~standard": {
        validate(input: unknown) {
          const body = input as PortalBody
          if (!Array.isArray(body.messages)) return { issues: ["messages must be an array"] }
          return { value: body }
        },
      },
    }
    const authenticate = vi.fn(({ rawBody, request }) => {
      expect(rawBody.length).toBeGreaterThan(0)
      return request.headers.get("x-quiver-chat-token") === "trusted"
        ? { invokerProfileId: "customer:acme" }
        : false
    })
    const run = vi.fn(async ({ context, invoker, run, runtimeContext }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string, customer?: string }, user?: { email?: string } } | undefined
      return `web ${run.channelId} ${run.origin} ${run.threadId} ${invoker.id} ${chatContext?.user?.email} ${chatContext?.meta?.customer} ${chatContext?.meta?.audience} runtime-body:${await runtimeContext.request.text()}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: {
              body: bodySchema,
              authenticate,
              context({ auth, body }) {
                return {
                  invokerProfileId: auth.invokerProfileId,
                  meta: body.meta,
                  run: { origin: "portal" },
                  user: body.user,
                }
              },
            },
          },
        }),
      },
      invoker: {
        profiles: [{
          id: "customer:acme",
          kind: "customerPortal",
          meta: { scope: "acme" },
        }],
      },
      driver: {
        run
      },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical", customer: "acme", source: "portal" },
        user: { email: "user@example.com" },
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    const responseText = await response.text()
    expect(responseText).toContain("web portal portal portal:portal-thread customer:acme user@example.com acme technical runtime-body:")
    expect(responseText).toContain("\\\"messages\\\"")
    expect(run).toHaveBeenCalled()
    authenticate.mockClear()

    const malformedResponse = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: "bad",
        meta: {},
        user: {},
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(malformedResponse.status).toBe(400)
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.stringContaining("portal-thread"),
    }))
    authenticate.mockClear()

    const rejectedResponse = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: {},
        user: {},
      }),
      headers: { "x-quiver-chat-token": "nope" },
      method: "POST",
    }), { agentName: "support" })

    expect(rejectedResponse.status).toBe(401)
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      error: "Agent chat route request was not admitted.",
    })
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.stringContaining("hello"),
    }))
  })

  it("returns a validation error for malformed AI SDK chat requests", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: { run: () => "unused" },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({ text: "hello" }),
      method: "POST",
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Agent chat payload requires a messages array.",
    })
  })

  it("rejects client-provided identity on generated AI SDK chat routes", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: { run: () => "unused" },
    }) as never)

    const protectedFields = {
      invoker: { id: "spoofed" },
      invokerProfileId: "customer:acme",
      meta: { customer: "acme" },
      run: { origin: "portal" },
      session: { id: "portal-session" },
      user: { id: "spoofed" },
    }

    for (const [field, value] of Object.entries(protectedFields)) {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify({
          messages: [{
            id: "user-1",
            parts: [{ text: "hello", type: "text" }],
            role: "user",
          }],
          [field]: value,
        }),
        method: "POST",
      }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: "Agent chat route identity must be derived server-side with defineAgent({ invoker }).",
      })
    }
  })

  it("copies trusted webChat route input after admission", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const authenticate = vi.fn(({ request }) => request.headers.get("x-quiver-chat-token") === "trusted" ? true : false)
    const run = vi.fn(({ context, invoker, run }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, session?: { id?: string }, user?: { email?: string } } | undefined
      return `trusted ${run.channelId} ${run.origin} ${run.threadId} ${invoker.id} ${chatContext?.user?.email} ${chatContext?.meta?.audience} ${chatContext?.session?.id}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate },
            input: { trust: ["meta", "user", "session"] },
          },
        }),
      },
      driver: { run },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical", customer: "acme" },
        run: { origin: "spoofed" },
        session: { id: "portal-session" },
        user: { email: "user@example.com" },
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("trusted portal web-chat portal:portal-thread web-chat:user@example.com user@example.com technical portal-session")
    expect(authenticate).toHaveBeenCalled()
    expect(run).toHaveBeenCalled()
  })

  it("does not copy untrusted session input after admission", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, session?: { id?: string }, user?: { email?: string } } | undefined
      return `trusted ${chatContext?.user?.email} ${chatContext?.meta?.audience} ${chatContext?.session?.id ?? "no-session"}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: () => true },
            input: { trust: ["meta", "user"] },
          },
        }),
      },
      driver: { run },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical" },
        session: { id: "portal-session" },
        user: { email: "user@example.com" },
      }),
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("trusted user@example.com technical no-session")
  })

  it("keeps admission context authoritative over trusted route input", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string, customer?: string } } | undefined
      return `trusted ${chatContext?.meta?.customer} ${chatContext?.meta?.audience}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: {
              authenticate: () => ({ customer: "server-customer" }),
              context({ auth, input }) {
                return {
                  meta: {
                    ...input.meta,
                    customer: auth.customer,
                  },
                }
              },
            },
            input: { trust: ["meta"] },
          },
        }),
      },
      driver: { run },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical", customer: "body-customer" },
      }),
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("trusted server-customer technical")
  })

  it("does not trust route input without admission authentication", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            input: { trust: ["meta"] },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { customer: "acme" },
      }),
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Agent chat route identity must be derived server-side with defineAgent({ invoker }).",
    })
  })

  it("maps trusted AI SDK chat route input before invoking the chat trigger", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context, invoker, run }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, user?: { email?: string } } | undefined
      return `portal ${run.origin} ${invoker.id} ${invoker.meta.scope} ${chatContext?.user?.email} ${chatContext?.meta?.audience}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      invoker: {
        profiles: [{
          id: "customer:acme",
          kind: "customerPortal",
          meta: { scope: "acme" },
        }],
      },
      driver: {
        run
      },
    }) as never, {
      mapInput({ body, request }) {
        if (request.headers.get("x-quiver-chat-token") !== "trusted") {
          throw new Error("Invalid Quiver Chat token.")
        }
        return {
          invokerProfileId: "customer:acme",
          meta: body.meta as Record<string, unknown>,
          run: body.run as never,
          user: body.user as Record<string, unknown>,
        }
      },
    })

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
        meta: { audience: "technical", customer: "acme", source: "portal" },
        run: { origin: "portal" },
        user: { email: "user@example.com" },
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    await expect(response.text()).resolves.toContain("portal portal customer:acme acme user@example.com technical")
    expect(run).toHaveBeenCalled()
  })

  it("handles Chat SDK webhooks through the chat capability", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access, staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const admitChat = vi.fn(({ invoker }) => invoker?.id === "customer:acme")
    const invokerResolve = vi.fn(({ defaultInvoker }) => {
      return {
        id: "customer:acme",
        kind: "customer",
        meta: defaultInvoker.meta,
      }
    })
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
        defineChatCapability({
          identity: ({ adapter, author }) => `${adapter}:${author.userId}`,
          platforms: {
            telegram: () => adapter as never,
          },
          transcripts: {
            maxPerUser: 50,
            retention: "30d",
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
      invoker: {
        resolve: invokerResolve,
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { email: "maxi@example.com", first_name: "Maxi", id: 123, username: "maxi" },
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
    expect(invokerResolve).toHaveBeenCalledOnce()
    expect(admitChat).toHaveBeenCalledWith(expect.objectContaining({
      invoker: expect.objectContaining({
        id: "customer:acme",
        kind: "customer",
        meta: expect.objectContaining({
          email: "maxi@example.com",
          id: "123",
          name: "Maxi",
          username: "maxi",
        }),
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
      invoker: expect.objectContaining({
        id: "customer:acme",
        meta: expect.objectContaining({
          email: "maxi@example.com",
        }),
      }),
      messages: [expect.objectContaining({
        metadata: expect.objectContaining({
          chat: expect.objectContaining({
            messageId: "7",
            platform: expect.objectContaining({
              channelId: "telegram:456",
              threadId: "telegram:456",
            }),
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
        channelId: "telegram:456",
        origin: "telegram",
        runId: "telegram:7",
      }),
    }))
  })

  it("routes channel webhook custom ids through the channel adapter", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(({ messages }) => {
      const text = messages[0]?.parts.find((part: { type?: string }) => part.type === "text") as { text?: string } | undefined
      return `echo: ${text?.text}`
    })
    const agent = defineAgent({
      channels: {
        support: http({
          adapter: () => adapter as never,
          webhooks: { id: "custom-support" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/custom-support", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          from: { id: 123, username: "maxi" },
          message_id: 7,
          text: "hello",
        },
      }),
      method: "POST",
    }), "custom-support")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({
        channelId: "support",
        origin: "support",
        runId: "support:7",
      }),
    }))
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "echo: hello" })
  })

  it("rejects unsigned chat channel webhooks before adapter dispatch", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        support: http({
          adapter: () => adapter as never,
          webhooks: { id: "custom-support", secretHeader: "x-test-secret", secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/custom-support", {
      body: "{}",
      method: "POST",
    }), "custom-support")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "[vitehub] Webhook secret header \"x-test-secret\" is required." })
    expect(adapter.handleWebhook).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("fails closed when generated chat webhook secrets resolve empty", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        support: http({
          adapter: () => adapter as never,
          webhooks: { id: "custom-support", secretHeader: "x-test-secret", secretToken: () => "" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/custom-support", {
      body: "{}",
      method: "POST",
    }), "custom-support")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "[vitehub] Webhook registration \"custom-support\" declares secretHeader \"x-test-secret\" but no secretToken is configured. Verification requires secretToken from Server Env; secretToken: false explicitly disables verification." })
    expect(adapter.handleWebhook).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("uses Telegram secret header defaults for generated chat webhooks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: "{}",
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "[vitehub] Webhook secret header \"x-telegram-bot-api-secret-token\" is required." })
    expect(adapter.handleWebhook).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("rejects generated GitHub webhooks without configured secrets", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: { webhook: { invoke: () => ({ input: { prompt: "github delivery" } }) } },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/github", {
      body: "{}",
      method: "POST",
    }), "github")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "[vitehub] Webhook registration \"github\" declares secretHeader \"x-hub-signature-256\" but no secretToken is configured. Verification requires secretToken from Server Env; secretToken: false explicitly disables verification." })
    expect(run).not.toHaveBeenCalled()
  })

  it("handles signed GitHub channel webhooks without a chat adapter", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const triggerInputs: unknown[] = []
    const run = vi.fn(({ input, run }) => ({
      raw: { context: input.context, run },
      text: "accepted",
    }))
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                triggerInputs.push(input)
                const deliveryId = (input as { github?: { deliveryId?: string } }).github?.deliveryId || "unknown"
                return {
                  input: {
                    context: { delivery: input },
                    prompt: "github delivery",
                  },
                  run: {
                    channelId: "github",
                    origin: "github",
                    runId: `github:${deliveryId}`,
                  },
                }
              },
            },
          },
          webhooks: { path: "/api/github/webhook", secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const payload = {
      action: "created",
      comment: { body: "/review", id: 12 },
      installation: { id: 4075547 },
      repository: { full_name: "acme/app" },
      sender: { login: "maxi" },
    }
    const body = JSON.stringify(payload)
    const request = (signature: string) => new Request("https://example.com/api/github/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      method: "POST",
    })

    const response = await handler(request(githubSignature("secret-token", body)))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ text: "accepted" })
    expect(triggerInputs).toHaveLength(1)
    expect(triggerInputs[0]).toMatchObject({
      github: {
        deliveryId: "delivery-1",
        event: "issue_comment",
        installationId: 4075547,
      },
      payload,
      provider: "github",
      request: {
        method: "POST",
        url: "https://example.com/api/github/webhook",
      },
      webhook: {
        channelId: "github",
        id: "github",
        path: "/api/github/webhook",
        provider: "github",
      },
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({
        channelId: "github",
        origin: "github",
        runId: "github:delivery-1",
      }),
    }))

    const rejected = await handler(request("sha256=wrong"))

    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toEqual({ error: "[vitehub] Webhook secret verification failed." })
    expect(run).toHaveBeenCalledOnce()

    const unsigned = await handler(new Request("https://example.com/api/github/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-unsigned",
        "x-github-event": "issue_comment",
      },
      method: "POST",
    }))

    expect(unsigned.status).toBe(401)
    await expect(unsigned.json()).resolves.toEqual({ error: "[vitehub] Webhook secret header \"x-hub-signature-256\" is required." })
    expect(run).toHaveBeenCalledOnce()
  })

  it("handles direct single-agent GitHub channel webhook routes", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({ input: { prompt: "github delivery" } }),
            },
          },
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const body = JSON.stringify({ action: "opened" })
    const response = await handler(new Request("https://example.com/api/github/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-direct",
        "x-github-event": "pull_request",
        "x-hub-signature-256": githubSignature("secret-token", body),
      },
      method: "POST",
    }), "")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toBe("accepted")
    expect(run).toHaveBeenCalledOnce()
  })

  it("lets signed GitHub channel webhooks return a handled response without running the agent", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const triggerInputs: unknown[] = []
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                triggerInputs.push(input)
                return Response.json({ ignored: true }, { status: 202 })
              },
            },
          },
          webhooks: { path: "/api/github/webhook", secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const body = JSON.stringify({
      action: "edited",
      comment: { body: "not a command", id: 12 },
      installation: { id: 4075547 },
    })
    const request = (signature: string) => new Request("https://example.com/api/github/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-ignored",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      method: "POST",
    })

    const response = await handler(request(githubSignature("secret-token", body)))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ ignored: true })
    expect(triggerInputs).toHaveLength(1)
    expect(triggerInputs[0]).toMatchObject({
      github: {
        deliveryId: "delivery-ignored",
        event: "issue_comment",
        installationId: 4075547,
      },
    })
    expect(run).not.toHaveBeenCalled()

    const rejected = await handler(request("sha256=wrong"))

    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toEqual({ error: "[vitehub] Webhook secret verification failed." })
    expect(run).not.toHaveBeenCalled()
  })

  it("does not route channel webhook arrays by unsuffixed channel id", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const agent = defineAgent({
      channels: {
        support: http({
          adapter: () => createTestChatAdapter() as never,
          webhooks: [
            { path: "/api/support/primary" },
            { path: "/api/support/fallback" },
          ],
        }),
      },
      driver: { run: () => "ok" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/support", {
      body: "{}",
      method: "POST",
    }), "support")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: "Unknown ViteHub agent webhook.", status: 404 })
  })

  it("does not route ambiguous provider webhook selectors", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        sales: http({ adapter: () => createTestChatAdapter() as never, webhooks: { id: "sales-hook" } }),
        support: http({ adapter: () => createTestChatAdapter() as never, webhooks: { id: "support-hook" } }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/http", {
      body: "{}",
      method: "POST",
    }), "http")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: "Unknown ViteHub agent webhook.", status: 404 })
    expect(run).not.toHaveBeenCalled()
  })

  it("does not route ambiguous webhook paths", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        primary: github({
          triggers: { webhook: { invoke: () => ({ input: { prompt: "primary" } }) } },
          webhooks: { id: "primary", path: "/api/github/webhook", secretToken: false },
        }),
        fallback: github({
          triggers: { webhook: { invoke: () => ({ input: { prompt: "fallback" } }) } },
          webhooks: { id: "fallback", path: "/api/github/webhook", secretToken: false },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/github/webhook", {
      body: "{}",
      method: "POST",
    }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: "Unknown ViteHub agent webhook.", status: 404 })
    expect(run).not.toHaveBeenCalled()
  })

  it("uses channel ids for same-kind channel webhook state", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const prefixes: string[] = []
    const agent = defineAgent({
      channels: {
        sales: http({ adapter: () => createTestChatAdapter() as never }),
        support: http({ adapter: () => createTestChatAdapter() as never }),
      },
      messages: {
        state: ({ chat }) => {
          prefixes.push(chat.stateKeyPrefix)
          return undefined as never
        },
      },
      driver: { run: () => "ok" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (webhook: string) => new Request(`https://example.com/api/_vitehub/agents/support/webhooks/${webhook}`, {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          from: { id: 123, username: "maxi" },
          message_id: 7,
          text: "hello",
        },
      }),
      method: "POST",
    })

    await expect(handler(request("support"), "support")).resolves.toMatchObject({ status: 200 })
    await expect(handler(request("sales"), "sales")).resolves.toMatchObject({ status: 200 })
    expect(prefixes).toEqual(["chat:agent:support:", "chat:agent:sales:"])
  })

  it("does not block chat webhook handling on typing status", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.startTyping.mockImplementation(() => new Promise(() => {}))
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: () => ({ text: "ok" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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

  it("continues refreshing typing status after a hung typing request", async () => {
    vi.useFakeTimers()
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let runStarted!: () => void
    let finishRun: () => void = () => {}
    const runStartedPromise = new Promise<void>(resolve => {
      runStarted = resolve
    })
    const finishRunPromise = new Promise<void>(resolve => {
      finishRun = resolve
    })
    adapter.startTyping.mockImplementation(() => new Promise(() => {}))
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => {
          runStarted()
          await finishRunPromise
          return "ok"
        } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 244,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 244,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram")

      await runStartedPromise
      await Promise.resolve()
      expect(adapter.startTyping).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(6000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(2)

      finishRun()
      const response = await responsePromise

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(2000)
    }
    finally {
      finishRun()
      vi.useRealTimers()
    }
  })

  it("refreshes typing status until the streamed chat response is committed", async () => {
    vi.useFakeTimers()
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let runStarted!: () => void
    let finishRun: () => void = () => {}
    let commitStarted!: () => void
    let commitResponse: () => void = () => {}
    const runStartedPromise = new Promise<void>(resolve => {
      runStarted = resolve
    })
    const finishRunPromise = new Promise<void>(resolve => {
      finishRun = resolve
    })
    const commitStartedPromise = new Promise<void>(resolve => {
      commitStarted = resolve
    })
    const commitResponsePromise = new Promise<void>(resolve => {
      commitResponse = resolve
    })
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>, options?: { updateIntervalMs?: number }) => {
      let text = ""
      for await (const chunk of textStream) {
        if (typeof chunk === "string") text += chunk
        else if (chunk.type === "markdown_text") text += chunk.text
      }
      commitStarted()
      await commitResponsePromise
      return { id: "stream-1", raw: { text }, threadId }
    })
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => {
          runStarted()
          await finishRunPromise
          return "ok"
        } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
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
      await Promise.resolve()
      expect(adapter.startTyping).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(3)

      finishRun()
      await commitStartedPromise
      expect(adapter.stream).toHaveBeenCalledWith("telegram:456", expect.any(Object), expect.objectContaining({
        updateIntervalMs: 1,
      }))
      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(4)

      commitResponse()
      const response = await responsePromise
      const callsAfterCommit = adapter.startTyping.mock.calls.length
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(adapter.editMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4000)
      expect(adapter.startTyping).toHaveBeenCalledTimes(callsAfterCommit)
      await vi.runOnlyPendingTimersAsync()
    }
    finally {
      finishRun()
      commitResponse()
      vi.useRealTimers()
    }
  })

  it("posts a default chat fallback while streamed webhook work is still running", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => {
          runStarted()
          await finishRunPromise
          return "done"
        } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 1044,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1044,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    await runStartedPromise
    await Promise.resolve()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "...")
    expect(adapter.editMessage).not.toHaveBeenCalled()

    finishRun()
    const response = await responsePromise

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "done" })
  })

  it("edits Telegram fallback with event stream text when textStream is empty", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { delta: "ok", type: "text-delta" }
            yield { finishReason: "stop", type: "finish" }
          })(),
          textStream: (async function* () {
            yield undefined
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 1049,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1049,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "ok" })
  })

  it("posts configured chat fallback while streamed webhook work is still running", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          fallbackStreamingPlaceholderText: "Working on it...",
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => {
          runStarted()
          await finishRunPromise
          return "done"
        } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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

  it("posts a random chat fallback option while streamed webhook work is still running", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75)
    try {
      const { defineAgent } = await import("../src/index.ts")
      const { defineChatCapability } = await import("../src/chat-trigger.ts")
      const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
          defineChatCapability({
            platforms: {
              telegram: () => adapter as never,
            },
            fallbackStreamingPlaceholderText: ["Working on it...", "Checking context..."],
            webhooks: {
              telegram: {},
            },
          }),
        ],
        driver: {
          run: async () => {
            runStarted()
            await finishRunPromise
            return "done"
          },
        },
      })
      const handler = createChannelWebhookRouteHandler(agent as never)

      const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 1048,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 1048,
            text: "hello",
          },
        }),
        method: "POST",
      }), "telegram")

      await runStartedPromise
      await Promise.resolve()
      expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "Checking context...")
      expect(adapter.editMessage).not.toHaveBeenCalled()

      finishRun()
      const response = await responsePromise

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "done" })
    }
    finally {
      random.mockRestore()
    }
  })

  it("activates Cloudflare env while webhook work runs", async () => {
    const { getActiveCloudflareEnv } = await import("@vite-hub/internal/runtime/cloudflare-env")
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: () => String(getActiveCloudflareEnv()?.OPENAI_API_KEY) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "runtime-openai-key" })
  })

  it("posts chat error fallback when deferred webhook work fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ deferMessageProcessing: true })
    const waitUntilTasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
          errorFallbackText: "No pude procesar ese mensaje.",
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: () => {
          throw new Error("transcription failed")
        } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
    const handler = createChannelWebhookRouteHandler(agent as never)

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

  it("passes configured thread history into chat webhook runs", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ persistThreadHistory: true })
    const runs: string[][] = []
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          history: { maxMessages: 25, source: "thread" },
          platforms: {
            telegram: () => adapter as never,
          },
          stream: false,
          threadHistory: { maxMessages: 25 },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: {
        run: ({ messages }) => {
          runs.push(messages.map(getMessageText))
          return `reply ${runs.length}`
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (messageId: number, text: string) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: messageId,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800 + messageId,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: messageId,
          text,
        },
      }),
      method: "POST",
    })

    await expect(handler(request(20, "remember BROWSER-HISTORY"), "telegram")).resolves.toMatchObject({ status: 200 })
    await expect(handler(request(21, "what marker did I ask you to remember?"), "telegram")).resolves.toMatchObject({ status: 200 })

    expect(runs).toEqual([
      ["remember BROWSER-HISTORY"],
      ["remember BROWSER-HISTORY", "reply 1", "what marker did I ask you to remember?"],
    ])
  })

  it("keeps fetched thread history when the current chat message has no id", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ missingIncomingMessageId: true })
    adapter.fetchMessages.mockResolvedValue({
      messages: [new Message({
        attachments: [],
        author: {
          fullName: "Maxi",
          isBot: false,
          isMe: false,
          userId: "123",
          userName: "maxi",
        },
        formatted: { children: [], type: "root" },
        id: undefined as unknown as string,
        metadata: { dateSent: new Date("2026-06-10T12:00:00.000Z"), edited: false },
        raw: {},
        text: "previous id-less",
        threadId: "telegram:456",
      })],
    })
    const runs: string[][] = []
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          history: { maxMessages: 10, source: "thread" },
          platforms: {
            telegram: () => adapter as never,
          },
          stream: false,
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: {
        run: ({ messages }) => {
          runs.push(messages.map(getMessageText))
          return "ok"
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    await expect(handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 22,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092822,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          text: "current id-less",
        },
      }),
      method: "POST",
    }), "telegram")).resolves.toMatchObject({ status: 200 })

    expect(runs).toEqual([["previous id-less", "current id-less"]])
  })

  it("passes durable thread history into chat webhook runs after adapter cache resets", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-history-state-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const runs: string[][] = []
    const request = (messageId: number, text: string) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: messageId,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800 + messageId,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: messageId,
          text,
        },
      }),
      method: "POST",
    })
    const handler = (adapter: ReturnType<typeof createTestChatAdapter>) => {
      const agent = defineAgent({
        capabilities: [
          defineChatCapability({
            history: { maxMessages: 25, source: "thread" },
            platforms: {
              telegram: () => adapter as never,
            },
            state: () => state,
            stream: false,
            threadHistory: { maxMessages: 25 },
            webhooks: {
              telegram: {},
            },
          }),
        ],
        driver: {
          run: ({ messages }) => {
            runs.push(messages.map(getMessageText))
            return `reply ${runs.length}`
          },
        },
      })
      return createChannelWebhookRouteHandler(agent as never)
    }

    try {
      await expect(handler(createTestChatAdapter({ persistThreadHistory: true }))(request(30, "remember DEPLOY-HISTORY"), "telegram")).resolves.toMatchObject({ status: 200 })
      await expect(handler(createTestChatAdapter({ persistThreadHistory: true }))(request(31, "what marker did I ask you to remember?"), "telegram")).resolves.toMatchObject({ status: 200 })

      expect(runs).toEqual([
        ["remember DEPLOY-HISTORY"],
        ["remember DEPLOY-HISTORY", "reply 1", "what marker did I ask you to remember?"],
      ])
    }
    finally {
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("runs non-streaming chat webhooks inline for workflow-backed agents", async () => {
    const { workflow } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
    const handler = createChannelWebhookRouteHandler(agent as never)
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
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      await chat?.sendMessage?.({ markdown: `side message via ${chat.provider}` })
    })
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
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
      driver: { run: () => ({ text: "agent answer" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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

  it("maps finish hook delivery artifacts to Chat SDK attachments", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { sendMessage?: (message: { artifacts: unknown[], markdown: string }) => Promise<void> } | undefined
      await chat?.sendMessage?.({
        artifacts: [{
          mediaType: "image/png",
          path: "screenshots/login.png",
          placement: "inline",
          url: "https://assets.example/screenshots/login.png",
        }],
        markdown: "See attached screenshot.",
      })
    })
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
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
      driver: { run: () => ({ text: "agent answer" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 1889,
        message: {
          chat: { id: 889, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1889,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:889", {
      attachments: [{
        mimeType: "image/png",
        name: "login.png",
        type: "image",
        url: "https://assets.example/screenshots/login.png",
      }],
      markdown: "See attached screenshot.",
    })
  })

  it("posts prepare-time channel delivery replies before the final chat answer", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "prepare-reply",
          prepare(context) {
            context.delivery.effect({ kind: "reply", payload: { body: "Preparing assets." } })
          },
        }),
      ],
      channels: {
        support: telegram({
          adapter: () => adapter as never,
        }),
      },
      driver: { run: () => "agent answer" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/support", {
      body: JSON.stringify({
        update_id: 1888,
        message: {
          chat: { id: 988, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1888,
          text: "hello",
        },
      }),
      method: "POST",
    }), "support")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:988", "...")
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:988", { markdown: "Preparing assets." })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:988", "sent-1", { markdown: "agent answer" })
  })

  it("posts finish channel delivery replies after input replacement and appends link artifacts", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "finish-link-reply",
          prepare(context) {
            context.input.set({ prompt: "rewritten" })
            context.delivery.finishEffect(() => ({
              artifacts: [{
                alt: "Result report",
                path: "reports/result.md",
                placement: "link",
                url: "https://assets.example/reports/result.md",
              }],
              kind: "reply",
              payload: { body: "See the report." },
            }))
          },
        }),
      ],
      channels: {
        support: telegram({
          adapter: () => adapter as never,
        }),
      },
      driver: { run: () => "agent answer" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/support", {
      body: JSON.stringify({
        update_id: 1887,
        message: {
          chat: { id: 987, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1887,
          text: "hello",
        },
      }),
      method: "POST",
    }), "support")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:987", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:987", "sent-1", { markdown: "agent answer" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:987", {
      markdown: "See the report.\n\n[Result report](<https://assets.example/reports/result.md>)",
    })
  })

  it("maps channel delivery reply artifacts to Chat SDK attachments and files", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const content = new Uint8Array([1, 2, 3])
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "delivery-assets",
          prepare(context) {
            context.delivery.finishEffect(() => ({
              artifacts: [{
                mediaType: "image/png",
                path: "screenshots/login.png",
                placement: "attachment",
              }, {
                mediaType: "image/png",
                path: "screenshots/published.png",
                placement: "inline",
                url: "https://assets.example/screenshots/published.png",
              }],
              kind: "reply",
              payload: { body: "See attached screenshots." },
            }))
          },
        }),
      ],
      channels: {
        support: telegram({
          adapter: () => adapter as never,
        }),
      },
      driver: {
        run: async ({ workspace }) => {
          await (workspace as { fs: { writeFile: (path: string, content: Uint8Array, options?: { mediaType?: string }) => Promise<void> } }).fs.writeFile("screenshots/login.png", content, { mediaType: "image/png" })
          return "agent answer"
        },
      },
      workspace: { mode: "write", store: { provider: "memory" } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/support", {
      body: JSON.stringify({
        update_id: 1989,
        message: {
          chat: { id: 989, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1989,
          text: "hello",
        },
      }),
      method: "POST",
    }), "support")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:989", "...")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:989", "sent-1", { markdown: "agent answer" })
    const deliveryMessage = adapter.postMessage.mock.calls[1]?.[1] as {
      attachments?: Array<{ mimeType?: string, name?: string, type?: string, url?: string }>
      files?: Array<{ data: ArrayBuffer, filename: string, mimeType?: string }>
      markdown?: string
    }
    expect(deliveryMessage).toMatchObject({
      attachments: [{
        mimeType: "image/png",
        name: "published.png",
        type: "image",
        url: "https://assets.example/screenshots/published.png",
      }],
      files: [{
        filename: "login.png",
        mimeType: "image/png",
      }],
      markdown: "See attached screenshots.",
    })
    expect(new Uint8Array(deliveryMessage.files![0]!.data)).toEqual(content)
  })

  it("commits native streamed chat responses before flushing finish hook messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>, options?: { updateIntervalMs?: number }) => {
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
    adapter.editMessage.mockImplementation(async () => {
      throw new Error("Bad Request: message is not modified")
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
        defineChatCapability({
          platforms: {
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
      driver: { run: () => ({ text: "agent answer" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
      expect(adapter.stream).toHaveBeenCalledWith("telegram:456", expect.any(Object), expect.objectContaining({
        updateIntervalMs: 1,
      }))
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
      expect(adapter.editMessage).not.toHaveBeenCalled()
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
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
      driver: { run: () => ({ text: "agent `answer`" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    const { access, staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
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
        defineChatCapability({
          platforms: {
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
      driver: { run: () => ({
          response: {
            modelId: "openai/gpt-test",
          },
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
          },
        }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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

  it("lets access() reject app-specific chat invokers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "unused")
    const agent = defineAgent({
      capabilities: [
        access({
          chat: {
            resolve: ({ invoker }) => invoker?.id === "123",
          },
        }),
        defineChatCapability({
          platforms: { telegram: () => adapter as never },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

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
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ secret: "secret" })
    const run = vi.fn(() => "unused")
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: {
            telegram: () => adapter as never,
          },
        }),
      ],
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({ update_id: 42 }),
      headers: { "x-test-secret": "wrong" },
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
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
