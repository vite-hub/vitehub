import { createHmac } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { Message } from "chat"
import { VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hubMarkdownTemplate } from "@vite-hub/markdown-template/vite"
import { build } from "vite"
import { describe, expect, it, vi } from "vitest"

import { resolveAgentCapabilities } from "../src/capability-runtime.ts"

import type { AgentMessageDeliveryKind } from "../src/index.ts"
import type { AgentChannelChatRouteStandardSchemaV1 } from "../src/server.ts"
import type { Adapter, ChatInstance, StreamChunk, WebhookOptions } from "chat"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

vi.mock("@vite-hub/internal/build/deployment-output", () => ({
  writeProviderDeploymentOutputs: vi.fn(async () => undefined),
}))

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

const execFileAsync = promisify(execFile)

function githubSignature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function testTelegram(
  telegram: typeof import("../src/channels.ts")["telegram"],
  options: NonNullable<Parameters<typeof telegram>[0]>,
) {
  return telegram({
    ...options,
    ...(options.webhooks === undefined && options.webhookSecret === undefined
      ? { webhooks: { secretToken: false } }
      : {}),
  })
}

const optionalMessageAdapterRuntimeExternals = [
  "bufferutil",
  "utf-8-validate",
  "zlib-sync",
]

const hostedAgentRoot = join(import.meta.dirname, "../../../fixtures/tutorials/agents")

function createTestChatAdapter(options: { attachmentFetchData?: () => Promise<Buffer>, deferMessageProcessing?: boolean, isDM?: boolean, missingIncomingMessageId?: boolean, persistThreadHistory?: boolean, photoData?: Blob, secret?: string } = {}) {
  let chatInstance: ChatInstance | undefined
  let sentMessageId = 0
  const cachedMessages = new Map<string, Message[]>()
  const cacheMessage = (message: Message) => {
    cachedMessages.set(message.threadId, [...(cachedMessages.get(message.threadId) ?? []), message])
  }
  const adapter = {
    _chatInstance: () => chatInstance,
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
      const from = rawMessage.from as { email?: string, id?: number | string, is_bot?: boolean, mail?: string, userPrincipalName?: string, username?: string } | undefined
      const document = rawMessage.document as { content?: string, file_id?: string, file_name?: string, file_size?: number, mime_type?: string, url?: string } | undefined
      const photos = rawMessage.photo as Array<{ file_id?: string, file_name?: string, file_size?: number, height?: number, url?: string, width?: number }> | undefined
      const photo = photos?.at(-1)
      const date = typeof rawMessage.date === "number"
        ? new Date(rawMessage.date * 1000)
        : new Date("2026-06-10T12:00:00.000Z")
      const message = new Message({
        attachments: rawMessage.audio
          ? [{
              fetchData: options.attachmentFetchData ?? (async () => Buffer.from([1, 2, 3])),
              fetchMetadata: { fileId: "audio-file" },
              mimeType: "audio/ogg",
              name: "voice.ogg",
              size: 3,
              type: "audio",
            }]
          : typeof document?.file_id === "string" && typeof document.mime_type === "string" && document.mime_type.startsWith("audio/")
            ? [{
                fetchData: options.attachmentFetchData ?? (async () => Buffer.from([1, 2, 3])),
                fetchMetadata: { fileId: document.file_id },
                mimeType: document.mime_type,
                name: document.file_name,
                size: document.file_size,
                type: "file",
                ...(typeof document.url === "string" ? { url: document.url } : {}),
              }]
          : document && (typeof document.file_id === "string" || typeof document.url === "string" || typeof document.content === "string")
            ? [{
                ...(typeof document.content === "string" ? { fetchData: options.attachmentFetchData ?? (async () => Buffer.from(document.content ?? "")) } : {}),
                ...(typeof document.file_id === "string" ? { fetchMetadata: { fileId: document.file_id } } : {}),
                ...(document.mime_type ? { mimeType: document.mime_type } : {}),
                name: document.file_name,
                size: document.file_size,
                type: "file",
                ...(typeof document.url === "string" ? { url: document.url } : {}),
              }]
          : typeof photo?.file_id === "string"
            ? [{
                ...(options.photoData
                  ? { data: options.photoData }
                  : { fetchData: options.attachmentFetchData ?? (async () => Buffer.from([1, 2, 3])) }),
                fetchMetadata: { fileId: photo.file_id },
                height: photo.height,
                name: photo.file_name,
                size: photo.file_size,
                type: "image",
                url: photo.url,
                width: photo.width,
              }]
          : [],
        author: {
          fullName: "Maxi",
          ...(from?.email ? { email: from.email } : {}),
          ...(from?.mail ? { mail: from.mail } : {}),
          ...(from?.userPrincipalName ? { userPrincipalName: from.userPrincipalName } : {}),
          isBot: from?.is_bot === true,
          isMe: false,
          userId: String(from?.id ?? "123"),
          userName: String(from?.username ?? "maxi"),
        },
        formatted: { children: [], type: "root" },
        id: options.missingIncomingMessageId ? undefined as unknown as string : String(rawMessage.message_id ?? "7"),
        isMention: rawMessage.isMention === true,
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
    deleteMessage: vi.fn(async () => {}),
    initialize: vi.fn(async (chat: ChatInstance) => {
      chatInstance = chat
    }),
    isDM: vi.fn(() => options.isDM ?? true),
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
    _chatInstance: () => ChatInstance | undefined
    deleteMessage: ReturnType<typeof vi.fn>
    handleWebhook: ReturnType<typeof vi.fn>
    editMessage: ReturnType<typeof vi.fn>
    fetchMessages: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
    startTyping: ReturnType<typeof vi.fn>
  }
}

function createTitleChatAdapter(setThreadTitle: (threadId: string, title: string) => Promise<void>) {
  return Object.assign(createTestChatAdapter(), { setThreadTitle })
}

function chatWebhookRequest(messageId: number, threadId = 456, text = "hello") {
  return new Request("https://example.com/api/_vitehub/agents/support/webhooks/channel", {
    body: JSON.stringify({
      message: {
        chat: { id: threadId, type: "private" },
        from: { id: 123, username: "maxi" },
        message_id: messageId,
        text,
      },
    }),
    method: "POST",
  })
}

describe("agent Vite plugin", () => {
  it("activates eval tooling only while executable eval files exist", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-eval-discovery-"))
    const serverDir = await mkdtemp(join(tmpdir(), "vitehub-agent-eval-server-"))
    const generatedConfig = join(root, ".vitehub", "agent", "evalite.config.ts")
    try {
      await mkdir(join(root, "evals"), { recursive: true })
      await writeFile(join(root, "evals", "cases.json"), "[]\n", "utf8")
      await writeFile(join(root, "evals", "reference.xlsx"), "fixture", "utf8")

      const plugin = hubAgent()
      const configResolved = plugin.configResolved as (config: {
        [VITEHUB_SERVER_DIRS]?: string[]
        command: "serve"
        root: string
      }) => Promise<void>
      const cli = plugin.vitehub?.cli as () => Promise<{
        namespaces: Array<{ features: Array<{ name: string }> }>
      }>
      const featureNames = async () => (await cli()).namespaces[0]!.features.map(feature => feature.name)

      await configResolved({ command: "serve", root })
      await expect(readFile(generatedConfig, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await expect(featureNames()).resolves.not.toContain("eval")

      const evalFile = join(serverDir, "agents", "support.eval.tsx")
      await mkdir(join(serverDir, "agents"), { recursive: true })
      await writeFile(evalFile, "export default defineEval({})", "utf8")
      await configResolved({ [VITEHUB_SERVER_DIRS]: [serverDir], command: "serve", root })
      await expect(readFile(generatedConfig, "utf8")).resolves.toContain("forceRerunTriggers")
      await expect(featureNames()).resolves.toContain("eval")

      await rm(evalFile)
      await configResolved({ command: "serve", root })
      await expect(readFile(generatedConfig, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await expect(featureNames()).resolves.not.toContain("eval")
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(serverDir, { force: true, recursive: true })
    }
  })

  it("keeps Agent generation and cleanup under a configured root", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-generated-root-"))
    const generatedRoot = join(root, ".nuxt", "vitehub")
    const generatedRoute = join(generatedRoot, "agent", "chat-webhook-route.ts")
    const generatedQueue = join(generatedRoot, "agent", "webhook-queue-plugin.ts")
    const generatedEvalConfig = join(generatedRoot, "agent", "evalite.config.ts")
    const evalFile = join(root, "support.eval.ts")
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      await writeFile(evalFile, "export default defineEval({})", "utf8")
      const plugin = hubAgent({ providers: { state: { provider: "sqlite", url: "file:.data/state.sqlite" } } })
      const config = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: "build", mode: "production" }) => Record<string, unknown>
      const configResolved = plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>
      const privateConfig = {
        [VITEHUB_GENERATED_ROOT]: generatedRoot,
        command: "build",
        plugins: [],
        root,
      }

      expect(await config(privateConfig, { command: "build", mode: "production" })).toMatchObject({
        nitro: {
          handlers: [{ handler: generatedRoute, route: "/api/_vitehub/agents/:agent/webhooks/:webhook" }],
          plugins: [generatedQueue],
        },
      })
      await configResolved(privateConfig)

      await expect(readFile(generatedRoute, "utf8")).resolves.toContain("server/agents/support.ts")
      await expect(readFile(generatedQueue, "utf8")).resolves.toContain("resumeWebhookQueues")
      await expect(readFile(generatedEvalConfig, "utf8")).resolves.toContain("forceRerunTriggers")
      await expect(readFile(join(root, ".vitehub", "agent", "chat-webhook-route.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

      await rm(evalFile)
      await configResolved({
        ...privateConfig,
        agent: { providers: { state: { provider: "memory" } } },
      })
      await expect(readFile(generatedQueue, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(generatedEvalConfig, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps the Deno cron import pointed at project-owned Schedule output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-generated-root-"))
    const generatedRoot = join(root, ".nuxt", "vitehub")
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ runtime: "deno" })
      const configResolved = plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>

      await configResolved({
        [VITEHUB_GENERATED_ROOT]: generatedRoot,
        command: "build",
        plugins: [],
        root,
      })

      const denoServer = await readFile(join(generatedRoot, "agent", "deno-server.ts"), "utf8")
      expect(denoServer).toContain('await import("../../../.vitehub/schedule/deno-cron.mjs").catch')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("bundles repository context templates into Vite builds", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(import.meta.dirname, ".repository-context-template-"))
    const serverDir = join(root, "backend")
    const agents = join(serverDir, "agents")
    const entry = join(agents, "reviewer.ts")
    const template = join(agents, "PULL_REQUEST.template.md")
    const outfile = join(root, "dist", "agent.mjs")
    try {
      await mkdir(agents, { recursive: true })
      await writeFile(join(root, "package.json"), "{}", "utf8")
      await writeFile(template, "# Pull request {{ pullRequest.number }}\n", "utf8")
      await writeFile(entry, [
        `"use server"`,
        `import { repositoryHostContext as context } from "@vite-hub/agent/capabilities"`,
        `const __vitehubRepositoryHostContextTemplate0 = "caller"`,
        `void __vitehubRepositoryHostContextTemplate0`,
        `export const local = (context: (options: unknown) => unknown) => context({ materialize: "./IGNORED.template.md" })`,
        `export default () => [context({ materialize: "./PULL_REQUEST.template.md" })]`,
        ``,
      ].join("\n"), "utf8")

      const runBuild = build as unknown as (config: unknown) => Promise<unknown>
      const agentPlugin: unknown = hubAgent()
      const markdownPlugin: unknown = hubMarkdownTemplate()
      await runBuild({
        [VITEHUB_SERVER_DIRS]: [serverDir],
        build: {
          emptyOutDir: true,
          lib: { entry, fileName: () => "agent.mjs", formats: ["es"] },
          minify: false,
          outDir: join(root, "dist"),
          rollupOptions: {
            external: ["@vite-hub/agent/capabilities", "@vite-hub/markdown-template"],
          },
        },
        logLevel: "silent",
        plugins: [agentPlugin, markdownPlugin],
        root,
      })

      await rm(template)
      const output = await readFile(outfile, "utf8")
      expect(output).toContain("# Pull request {{ pullRequest.number }}")
      expect(output).toContain('path: "PULL_REQUEST.md"')
      expect(output).toContain('materialize: "./IGNORED.template.md"')
      expect(output).toMatch(/^"use server";/)
      expect(output).not.toContain("readFile")
      const bundled = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => [unknown] }
      const resolved = await resolveAgentCapabilities({
        capabilities: [bundled.default()[0] as never],
      }, {
        capabilities: {},
        memo: vi.fn(),
        runtime: "unknown",
        runtimeConfig: {},
        waitUntil: vi.fn(),
      }, {
        context: {
          pullRequest: {
            pullRequest: {
              apiUrl: "https://api.github.com/repos/acme/app/pulls/42",
              number: 42,
              source: {
                mount: "app",
                ref: "refs/pull/42/head",
                repo: "acme/app",
              },
            },
            repository: {
              fullName: "acme/app",
              name: "app",
              owner: "acme",
            },
          },
        } as never,
      }, {
        fs: {
          exists: vi.fn(async () => false),
          glob: vi.fn(async () => []),
          list: vi.fn(async () => []),
          materializeSources: vi.fn(async () => ({ bytes: 0, directories: 0, durationMs: 0, files: 0, path: "", sources: [] })),
          readFile: vi.fn(async () => { throw new Error("missing") }),
          search: vi.fn(async () => []),
          stat: vi.fn(async () => { throw new Error("missing") }),
        },
        tools: {
          inspect: vi.fn(() => ({})),
          none: vi.fn(() => ({})),
        },
      } as never, "read", {
        workspaceDefinition: {
          name: "review",
          sources: {},
        },
      })
      expect(resolved.workspaceDefinition?.sources?.["repository-host-context"]).toMatchObject({
        content: "# Pull request 42",
        materialize: "build",
        workspacePath: "PULL_REQUEST.md",
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 15_000)

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
    const plugin = hubAgent({ routes: { discordGateway: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({ agent: { routes: { discordGateway: true } } })
  })

  it("adds discovered Agents to runtime Schedule registry and target names", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-schedule-targets-"))
    try {
      await mkdir(join(root, "server", "agents", "support", "workspace"), { recursive: true })
      await mkdir(join(root, "server", "agents", "support", "home", ".codex"), { recursive: true })
      await mkdir(join(root, "server", "agents", "digest"), { recursive: true })
      await writeFile(join(root, "server", "agents", "digest", "agent.ts"), "export default {}", "utf8")
      await writeFile(join(root, "server", "agents", "digest", "instructions.md"), "Use digest instructions.\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default defineAgent({ workspace: {} })", "utf8")
      await writeFile(join(root, "server", "agents", "support", "instructions.md"), "Use support instructions.\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "home", ".codex", "config.toml"), "model = 'codex'\n", "utf8")
      const plugin = hubAgent()
      const configResolved = plugin.configResolved as unknown as (config: { agent?: unknown, command: "serve", createResolver: () => (id: string) => Promise<string | undefined>, plugins: Array<{ name: string }>, root: string }) => Promise<void>
      const transform = plugin.transform as (code: string, id: string) => Promise<string | undefined>
      await configResolved({
        command: "serve",
        createResolver: () => async id => `/app/node_modules/${id}`,
        plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/database/vite" }, { name: "@vite-hub/email/vite" }, { name: "@vite-hub/kv/vite" }],
        root,
      })

      const registry = await transform("const registry = { reports: async () => ({}) }\nexport default registry\n", "\0#vitehub/schedule/registry")
      const targets = await transform("export const scheduleTargetNames = [\"reports\"];\n", "\0#vitehub/schedule/targets")

      expect(registry).toContain("defineScheduledAgentTarget")
      expect(registry).toContain('import { blob as vitehubBlob } from "@vite-hub/blob"')
      expect(registry).toContain('import { agentDb as vitehubDb } from "@vite-hub/database/drizzle"')
      expect(registry).toContain('import { email as vitehubEmail } from "@vite-hub/email/server"')
      expect(registry).toContain('import { kv as vitehubKv } from "@vite-hub/kv"')
      expect(registry).toContain('import { schedules as vitehubSchedules } from "@vite-hub/schedule/runtime"')
      expect(registry).toContain('{ agentIdentity: {"name":"digest"}, capabilities: { blob: vitehubBlob, db: vitehubDb, email: vitehubEmail, kv: vitehubKv, schedule: { schedules: vitehubSchedules } } }')
      expect(registry).toContain('registry["agent/digest"]')
      expect(registry).toContain('vitehubAgentWithColocatedInstructions(vitehubResolveScheduledAgentModule(module), "Use digest instructions.\\n")')
      expect(registry).not.toContain("withAgentDefaults")
      expect(registry).toContain('registry["agent/support"]')
      expect(registry).toContain('agentIdentity: {"name":"support","workspace":"support"}')
      expect(registry).toContain("vitehubWithWorkspaceSourceRoot")
      expect(registry).toContain("vitehubAgentWithColocatedHome")
      expect(registry).toContain(Buffer.from("model = 'codex'\n").toString("base64"))
      expect(registry).toContain("vitehubWorkspaceDefinitionFromOptions")
      expect(registry).toContain(JSON.stringify(join(root, "server", "agents", "support", "workspace")))
      expect(registry).toContain(JSON.stringify("Use support instructions.\n"))
      expect(registry).toContain('__vitehubAgentInstructions')
      expect(registry).not.toContain("cron:")
      expect(registry).not.toContain("setAgentWorkflowRuntimeLoaders")
      expect(targets).toContain('scheduleTargetNames.push("agent/digest")')
      expect(targets).toContain('scheduleTargetNames.push("agent/support")')

      const filteredPlugin = hubAgent({
        importBase: "vite-hub/_internal/agent",
        runtimeCapabilityImports: {
          blob: false,
          email: "vite-hub/email/server",
          kv: "vite-hub/_internal/kv",
        },
        workflowImportBase: "vite-hub/_internal/workflow",
        workspaceDependencyRuntimeImports: {
          sandbox: "@vite-hub/sandbox",
          sandboxRuntimeState: "vite-hub/_internal/sandbox/runtime/state",
          shellWorkspace: "vite-hub/shell/workspace",
        },
        workspaceImportBase: "vite-hub/_internal/workspace",
      } as never)
      const filteredConfigResolved = filteredPlugin.configResolved as unknown as typeof configResolved
      const filteredTransform = filteredPlugin.transform as typeof transform
      await filteredConfigResolved({
        command: "serve",
        createResolver: () => async id => id === "vite-hub/email/server" || id === "vite-hub/_internal/kv" ? `/app/node_modules/${id}` : undefined,
        plugins: [{ name: "@vite-hub/email/vite" }, { name: "@vite-hub/kv/vite" }],
        root,
      })
      const filteredRegistry = await filteredTransform("const registry = {}\nexport default registry\n", "\0#vitehub/schedule/registry")
      expect(filteredRegistry).not.toContain('vite-hub/_internal/blob')
      expect(filteredRegistry).toContain("blob: false")
      expect(filteredRegistry).toContain('import { email as vitehubEmail } from "vite-hub/email/server"')
      expect(filteredRegistry).toContain('import { kv as vitehubKv } from "vite-hub/_internal/kv"')
      expect(filteredRegistry).toContain('{ agentIdentity: {"name":"digest"}, capabilities: { blob: false, email: vitehubEmail, kv: vitehubKv, schedule: { schedules: vitehubSchedules } } }')
      expect(filteredRegistry).toContain('import { setAgentWorkflowRuntimeLoaders as vitehubSetAgentWorkflowRuntimeLoaders } from "vite-hub/_internal/agent/server/internal"')
      expect(filteredRegistry).toContain('import { agentWithColocatedHome as vitehubAgentWithColocatedHome } from "vite-hub/_internal/agent/runtime/workflow"')
      expect(filteredRegistry).toContain('workflow: () => import("vite-hub/_internal/workflow")')
      expect(filteredRegistry).toContain('import { setWorkspaceDependencyRuntimeLoaders as vitehubSetWorkspaceDependencyRuntimeLoaders } from "vite-hub/_internal/workspace/runtime"')
      expect(filteredRegistry).toContain('sandbox: () => import("@vite-hub/sandbox")')

      const composedBlobPlugin = hubAgent({
        runtimeCapabilityImports: { blob: false },
      } as never)
      const composedBlobConfigResolved = composedBlobPlugin.configResolved as unknown as typeof configResolved
      const composedBlobTransform = composedBlobPlugin.transform as typeof transform
      await composedBlobConfigResolved({
        command: "serve",
        createResolver: () => async id => id === "@vite-hub/blob" ? `/app/node_modules/${id}` : undefined,
        plugins: [{ name: "@vite-hub/blob/vite" }],
        root,
      })
      const composedBlobRegistry = await composedBlobTransform("const registry = {}\nexport default registry\n", "\0#vitehub/schedule/registry")
      expect(composedBlobRegistry).toContain('import { blob as vitehubBlob } from "@vite-hub/blob"')
      expect(composedBlobRegistry).toContain("blob: vitehubBlob")
      expect(composedBlobRegistry).not.toContain("blob: false")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs portable Capability loaders in generated Agent Workflow registries", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-capabilities-"))
    try {
      const plugin = hubAgent()
      const configResolved = plugin.configResolved as unknown as (config: { command: "build", createResolver: () => (id: string) => Promise<string | undefined>, plugins: Array<{ name: string }>, root: string }) => Promise<void>
      const transform = plugin.transform as (code: string, id: string) => Promise<string | undefined>
      await configResolved({
        command: "build",
        createResolver: () => async id => `/app/node_modules/${id}`,
        plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/database/vite" }, { name: "@vite-hub/email/vite" }],
        root,
      })

      const registry = await transform("const registry = {}\nexport default registry\n", "/virtual/.vitehub/workflow/registry.mjs")
      const providerRegistry = plugin.vitehub?.agent?.transformWorkflowRegistry(
        "const registry = {}\nexport default registry\n",
        join(root, ".vitehub", "workflow", "registry.mjs"),
      )
      const windowsProviderRegistry = plugin.vitehub?.agent?.transformWorkflowRegistry(
        "const registry = {}\nexport default registry\n",
        "C:\\app\\.vitehub\\workflow\\registry.mjs",
      )
      const nitroPlugin = hubAgent()
      const nitroConfig = nitroPlugin.config as (config: Record<string | symbol, unknown>, environment: { command: "build", mode: string }) => Promise<unknown>
      await nitroConfig({
        [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
        plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/database/vite" }],
        root,
      }, { command: "build", mode: "production" } as never)
      const nitroRegistry = nitroPlugin.vitehub?.agent?.transformWorkflowRegistry(
        "const registry = {}\nexport default registry\n",
        join(root, ".vitehub", "workflow", "registry.mjs"),
      )

      expect(registry).toContain('import { blob as vitehubBlob } from "@vite-hub/blob"')
      expect(registry).toContain('import { agentDb as vitehubDb } from "@vite-hub/database/drizzle"')
      expect(registry).toContain('import { setAgentWorkflowCapabilityLoaders as vitehubSetAgentWorkflowCapabilityLoaders } from "@vite-hub/agent/server/internal"')
      expect(registry).toContain("blob: () => vitehubBlob")
      expect(registry).toContain("db: () => vitehubDb")
      expect(registry).not.toContain("vitehubEmail")
      expect(providerRegistry).toBe(registry)
      expect(windowsProviderRegistry).toBe(registry)
      expect(nitroRegistry).toBe(registry)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("leaves Schedule virtual modules unchanged without discovered Agents", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-empty-schedule-targets-"))
    try {
      const plugin = hubAgent()
      const configResolved = plugin.configResolved as (config: { agent?: unknown, command: "serve", root: string }) => Promise<void>
      const transform = plugin.transform as (code: string, id: string) => Promise<string | undefined>
      await configResolved({ command: "serve", root })

      await expect(transform("const registry = {}\nexport default registry\n", "\0#vitehub/schedule/registry")).resolves.toBeUndefined()
      await expect(transform("export const scheduleTargetNames = [];\n", "\0#vitehub/schedule/targets")).resolves.toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("invalidates runtime Schedule modules when an Agent changes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const registryModule = { id: "registry" }
    const targetsModule = { id: "targets" }
    const nitroRegistryModule = { id: "nitro-registry" }
    const generatedRouteModule = { id: "generated-route" }
    const configResolved = plugin.configResolved as unknown as (config: { agent?: unknown, command: "serve", plugins: never[], root: string }) => Promise<void>
    const config = plugin.config as unknown as (config: Record<string, unknown>) => void
    config({ __vitehubServerDirs: ["/app/backend"] })
    await configResolved({ command: "serve", plugins: [], root: "/app" })
    const modules = new Map<string, object>([
      ["\0#vitehub/schedule/registry", registryModule],
      ["\0#vitehub/schedule/targets", targetsModule],
      ["/app/.vitehub/nitro/schedule/runtime-registry.js", nitroRegistryModule],
      ["/app/.vitehub/agent/chat-webhook-route.ts", generatedRouteModule],
    ])
    const getModuleById = vi.fn((id: string) => modules.get(id))
    const invalidateModule = vi.fn()
    const handleHotUpdate = plugin.handleHotUpdate as (context: unknown) => Promise<void>

    await handleHotUpdate({
      file: "/app/backend/agents/digest.ts",
      server: { config: { root: "/app" }, moduleGraph: { getModuleById, invalidateModule } },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registryModule)
    expect(invalidateModule).toHaveBeenCalledWith(targetsModule)
    expect(invalidateModule).toHaveBeenCalledWith(nitroRegistryModule)

    invalidateModule.mockClear()
    await handleHotUpdate({
      file: "/app/backend/agents/digest/skills/review/SKILL.md",
      server: { config: { root: "/app" }, moduleGraph: { getModuleById, invalidateModule } },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registryModule)
    expect(invalidateModule).toHaveBeenCalledWith(targetsModule)
    expect(invalidateModule).toHaveBeenCalledWith(nitroRegistryModule)
    expect(invalidateModule).toHaveBeenCalledWith(generatedRouteModule)

    invalidateModule.mockClear()
    await handleHotUpdate({
      file: "/app/backend/agents/digest/home/.codex/config.toml",
      server: { config: { root: "/app" }, moduleGraph: { getModuleById, invalidateModule } },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registryModule)
    expect(invalidateModule).toHaveBeenCalledWith(targetsModule)
    expect(invalidateModule).toHaveBeenCalledWith(nitroRegistryModule)
    expect(invalidateModule).toHaveBeenCalledWith(generatedRouteModule)
  })

  it("regenerates Agent outputs when an imported instruction document changes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-instruction-update-"))
    try {
      const agentRoot = join(root, "server", "agents", "digest")
      await mkdir(agentRoot, { recursive: true })
      await writeFile(join(agentRoot, "agent.ts"), "export default {}", "utf8")
      await writeFile(join(agentRoot, "instructions.md"), "@./tone.md\n", "utf8")
      await writeFile(join(agentRoot, "tone.md"), "Use a concise tone.\n", "utf8")

      const plugin = hubAgent()
      const configResolved = plugin.configResolved as unknown as (config: { agent?: unknown, command: "serve", plugins: never[], root: string }) => Promise<void>
      await configResolved({ command: "serve", plugins: [], root })
      const generatedRouteModule = { id: "generated-route" }
      const getModuleById = vi.fn((id: string) => id === join(root, ".vitehub/agent/chat-webhook-route.ts")
        ? generatedRouteModule
        : undefined)
      const invalidateModule = vi.fn()
      const handleHotUpdate = plugin.handleHotUpdate as (context: unknown) => Promise<void>

      await handleHotUpdate({
        file: join(agentRoot, "tone.md"),
        server: { moduleGraph: { getModuleById, invalidateModule } },
      })

      expect(invalidateModule).toHaveBeenCalledWith(generatedRouteModule)

      invalidateModule.mockClear()
      await rm(join(agentRoot, "instructions.md"))
      await handleHotUpdate({
        file: join(agentRoot, "instructions.md"),
        server: { moduleGraph: { getModuleById, invalidateModule } },
      })

      expect(invalidateModule).toHaveBeenCalledWith(generatedRouteModule)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("materializes the MCP runtime package for Vercel build output", async () => {
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
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
    const generatedRoot = join(root, ".nuxt", "vitehub")
    const previousHosting = process.env.VITEHUB_HOSTING
    const previousNetlify = process.env.NETLIFY
    try {
      process.env.VITEHUB_HOSTING = "netlify"
      delete process.env.NETLIFY
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const agentOptions = {
        providerImportAliases: {
          "@vite-hub/kv/runtime/upstash-driver": "vite-hub/_internal/kv/runtime/disabled-upstash",
        },
        providers: {
          state: {
            authToken: "build-token",
            provider: "libsql",
            tablePrefix: "agent_state_",
            url: "libsql://state.example.test",
          },
        },
        routes: { chat: true, discordGateway: true },
        workflowImportBase: "vite-hub/_internal/workflow",
        workspaceDependencyRuntimeImports: {
          sandbox: "vite-hub/sandbox",
          sandboxRuntimeState: "vite-hub/_internal/sandbox/runtime/state",
          shellWorkspace: "vite-hub/shell/workspace",
        },
        workspaceImportBase: "vite-hub/_internal/workspace",
      }
      const plugin = hubAgent(agentOptions as never)
      const configResolved = plugin.configResolved as (config: { [VITEHUB_GENERATED_ROOT]?: string, agent?: unknown, build?: { outDir?: string }, command: "build", resolve: { alias: Array<{ find: string, replacement: string }> }, root: string }) => Promise<void>
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
      vi.mocked(writeProviderDeploymentOutputs).mockClear()

      await configResolved({
        [VITEHUB_GENERATED_ROOT]: generatedRoot,
        agent: agentOptions,
        build: { outDir: "dist/client" },
        command: "build",
        resolve: { alias: [{ find: "#support", replacement: join(root, "support.ts") }] },
        root,
      })
      await closeBundle.handler()

      const wrapper = await readFile(join(generatedRoot, "agent/netlify-function.mjs"), "utf8")
      await execFileAsync(process.execPath, ["--check", join(generatedRoot, "agent/netlify-function.mjs")])
      expect(wrapper).toContain("server/agents/support.ts")
      expect(wrapper).toContain("export default async function viteHubAgentNetlifyFunction(request, context)")
      expect(wrapper).toContain("import { setAgentWorkflowRuntimeLoaders as vitehubSetAgentWorkflowRuntimeLoaders } from \"@vite-hub/agent/server/internal\"")
      expect(wrapper).toContain("state: () => import(\"vite-hub/_internal/workflow/runtime/state\")")
      expect(wrapper).toContain("workflow: () => import(\"vite-hub/_internal/workflow\")")
      expect(wrapper).toContain("import { setWorkspaceDependencyRuntimeLoaders as vitehubSetWorkspaceDependencyRuntimeLoaders } from \"vite-hub/_internal/workspace/runtime\"")
      expect(wrapper).toContain("sandbox: () => import(\"vite-hub/sandbox\")")
      expect(wrapper).toContain("sandboxRuntimeState: () => import(\"vite-hub/_internal/sandbox/runtime/state\")")
      expect(wrapper).toContain("shellWorkspace: () => import(\"vite-hub/shell/workspace\")")
      expect(wrapper).toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/agent/server/workspace\"")
      expect(wrapper).not.toContain("@vite-hub/workspace/internal/runtime/state")
      expect(wrapper).toContain("process.env.VITEHUB_HOSTING = 'netlify'")
      expect(wrapper).toContain("const waitUntil = waitUntilFromContext(context)")
      expect(wrapper).toContain("const webhook = netlifyParam(context, 'webhook')")
      expect(wrapper).toContain("const isDiscordGatewayRoute = discordGatewayRoutePattern.test(pathname)")
      expect(wrapper).toContain("VITEHUB_DISCORD_GATEWAY_SECRET")
      expect(wrapper).toContain("VITEHUB_DISCORD_GATEWAY_DURATION_MS")
      expect(wrapper).toContain("VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL")
      expect(wrapper).toContain("const webhookRoute = \"/api/_vitehub/agents/:agent/webhooks/:webhook\"")
      expect(wrapper).toContain("routePath(webhookRoute, { agent, webhook })")
      expect(wrapper).toContain("import { createLibsqlAgentState } from \"@vite-hub/agent/state/sqlite\"")
      expect(wrapper).toContain("const viteHubChatStateOptions = {\"tablePrefix\":\"agent_state_\",\"url\":\"libsql://state.example.test\"}")
      expect(wrapper).toContain("let viteHubChatState\n")
      expect(wrapper).not.toContain("let viteHubChatState:")
      expect(wrapper).not.toContain("build-token")
      expect(wrapper).toContain("function chatStateFromLibsql()")
      expect(wrapper).toContain("export function resumeWebhookQueues(waitUntil)")
      expect(wrapper).toContain("stopWebhookQueues ||= resumeWebhookQueues(waitUntil)")
      expect(wrapper).toContain("handler(request, webhook, { agentIdentity: agentIdentities[agent], state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, waitUntil })")
      expect(wrapper).not.toContain("runtime: 'vite'")
      expect(wrapper).not.toContain("@vite-hub/schedule/runtime")
      expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith({
        clientOutDir: "dist/client",
        netlify: {
          functions: [{
            bundleEntry: join(generatedRoot, "agent/netlify-function.mjs"),
            bundleOptions: {
              alias: {
                "#support": join(root, "support.ts"),
                "@vite-hub/kv/runtime/upstash-driver": "vite-hub/_internal/kv/runtime/disabled-upstash",
              },
              external: [
                "@ai-sdk/harness",
                "@ai-sdk/harness/*",
                "@ai-sdk/mcp",
                "@modelcontextprotocol/sdk/*",
                "agents",
                "evalite/*",
                ...optionalMessageAdapterRuntimeExternals,
                "vitest/*",
              ],
              format: "esm",
              platform: "node",
            },
            config: {
              name: "vitehub-agent",
              nodeBundler: "esbuild",
              path: [
                "/api/_vitehub/agents/:agent/chat",
                "/api/_vitehub/agents/:agent/webhooks/:webhook",
                "/api/_vitehub/agents/:agent/discord/gateway",
              ],
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

  it("publishes Netlify chat paths only when configured", async () => {
    const { writeProviderDeploymentOutputs } = await import("@vite-hub/internal/build/deployment-output")
    const { hubAgent } = await import("../src/vite.ts")
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.VITEHUB_HOSTING = "netlify"

    try {
      for (const testCase of [
        { chat: undefined, expectedPattern: "(?!)", expectedPaths: "/api/_vitehub/agents/:agent/webhooks/:webhook" },
        { chat: false, expectedPattern: "(?!)", expectedPaths: "/api/_vitehub/agents/:agent/webhooks/:webhook" },
        {
          chat: true,
          expectedPattern: "^/api/_vitehub/agents/[^/]+/chat$",
          expectedPaths: ["/api/_vitehub/agents/:agent/chat", "/api/_vitehub/agents/:agent/webhooks/:webhook"],
        },
        {
          chat: "/chat/[agent]",
          expectedPattern: "^/chat/[^/]+$",
          expectedPaths: ["/chat/:agent", "/api/_vitehub/agents/:agent/webhooks/:webhook"],
        },
      ] as const) {
        const root = await mkdtemp(join(tmpdir(), "vitehub-agent-netlify-chat-route-"))
        try {
          await mkdir(join(root, "server", "agents"), { recursive: true })
          await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
          const routes = testCase.chat === undefined ? undefined : { chat: testCase.chat }
          const plugin = hubAgent({ providers: { state: { provider: "memory" } }, routes } as never)
          const configResolved = plugin.configResolved as unknown as (config: {
            agent?: unknown
            build?: { outDir?: string }
            command: "build"
            resolve: { alias: Array<{ find: string, replacement: string }> }
            root: string
          }) => Promise<void>
          const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
          vi.mocked(writeProviderDeploymentOutputs).mockClear()

          await configResolved({
            agent: { providers: { state: { provider: "memory" } }, routes },
            build: { outDir: "dist/client" },
            command: "build",
            resolve: { alias: [] },
            root,
          })
          await closeBundle.handler()

          const wrapper = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
          expect(wrapper).toContain(`const chatRoutePattern = new RegExp(${JSON.stringify(testCase.expectedPattern)})`)
          expect(wrapper).toContain("const isChatRoute = chatRoutePattern.test(pathname)")
          expect(wrapper).toContain("isDiscordGatewayRoute ? discordGatewayHandlers[agent] : isWebhookRoute ? webhookHandlers[agent] : isChatRoute ? chatHandlers[agent] : undefined")
          if (testCase.chat) {
            expect(wrapper).toContain("createChannelChatRouteHandler")
          }
          else {
            expect(wrapper).not.toContain("createChannelChatRouteHandler")
            expect(wrapper).toContain("const chatHandlers = {}")
          }
          expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith(expect.objectContaining({
            netlify: expect.objectContaining({
              functions: [expect.objectContaining({
                config: expect.objectContaining({ path: testCase.expectedPaths }),
              })],
            }),
          }))
        }
        finally {
          await rm(root, { force: true, recursive: true })
        }
      }
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
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
      const plugin = hubAgent({
        providerImportAliases: {
          "@vite-hub/kv/runtime/upstash-driver": "vite-hub/_internal/kv/runtime/disabled-upstash",
        },
        routes: { chat: true },
      } as never)
      const configResolved = plugin.configResolved as (config: { build?: { outDir?: string }, command: "serve", resolve: { alias: Array<{ find: string, replacement: string }> }, root: string }) => Promise<void>
      vi.mocked(writeProviderDeploymentOutputs).mockClear()

      await configResolved({
        build: { outDir: "dist/client" },
        command: "serve",
        resolve: { alias: [] },
        root,
      })

      const wrapper = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
      expect(wrapper).toContain("handler(request, webhook, { agentIdentity: agentIdentities[agent], runtime: 'vite', state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, waitUntil })")
      expect(wrapper).toContain("handler(request, { agentIdentity: agentIdentities[agent], runtime: 'vite', waitUntil })")
      expect(writeProviderDeploymentOutputs).toHaveBeenCalledWith(expect.objectContaining({
        netlify: expect.objectContaining({
          functions: [expect.objectContaining({
            bundleOptions: expect.objectContaining({
              alias: {
                "@vite-hub/kv/runtime/upstash-driver": "vite-hub/_internal/kv/runtime/disabled-upstash",
              },
              external: expect.arrayContaining([
                "@vite-hub/sandbox",
                "@vite-hub/shell/*",
                "@vite-hub/workflow",
              ]),
            }),
            config: expect.objectContaining({
              path: [
                "/api/_vitehub/agents/:agent/chat",
                "/api/_vitehub/agents/:agent/webhooks/:webhook",
              ],
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
      const plugin = hubAgent()
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

  it("publishes Nitro chat routes only when configured", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const handlers = async (chat?: boolean | string) => {
      const plugin = hubAgent(chat === undefined ? undefined : { routes: { chat } })
      const result = typeof plugin.config === "function"
        ? await plugin.config.call({} as never, { root: hostedAgentRoot }, { command: "build", mode: "production" })
        : undefined
      return (result as { nitro?: { handlers?: unknown[] } } | undefined)?.nitro?.handlers
    }
    const webhook = {
      handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    }

    await expect(handlers()).resolves.toEqual([webhook])
    await expect(handlers(false)).resolves.toEqual([webhook])
    await expect(handlers(true)).resolves.toEqual([
      {
        handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
        route: "/api/_vitehub/agents/:agent/chat",
      },
      webhook,
    ])
    await expect(handlers("/chat/[agent]")).resolves.toEqual([
      {
        handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
        route: "/chat/:agent",
      },
      webhook,
    ])

    const plugin = hubAgent({ routes: { chat: "/chat/[agent]" } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, { root: hostedAgentRoot }, { command: "build", mode: "production" })
      : undefined
    expect(result).toMatchObject({
      define: {
        __VITEHUB_AGENT_CHAT_ROUTE__: JSON.stringify("/chat/[agent]"),
      },
    })
  })

  it("does not register agent routes without hosted Agents", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, { root: join(import.meta.dirname, "fixtures") }, { command: "build", mode: "production" })
      : undefined

    expect((result as { nitro?: unknown } | undefined)?.nitro).toBeUndefined()
  })

  it("inlines Agent runtimes in Nitro output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {
          [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
          nitro: { externals: { inline: ["existing"] } },
        } as never, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        externals: {
          inline: ["existing", "vite-hub", "@vite-hub/agent", "@ai-sdk/mcp"],
        },
      },
    })
  })

  it("registers configured Discord Gateway routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { discordGateway: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, { root: hostedAgentRoot }, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: expect.arrayContaining([
          {
            handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
            route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
          },
          {
            handler: join(hostedAgentRoot, ".vitehub/agent/discord-gateway-route.ts"),
            route: "/api/_vitehub/agents/:agent/discord/gateway",
          },
        ]),
      },
    })
  })

  it("writes generated Discord Gateway route handlers", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-discord-gateway-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { discordGateway: true } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "serve", root } as never)
      }

      const gatewayRoute = await readFile(join(root, ".vitehub/agent/discord-gateway-route.ts"), "utf8")

      expect(gatewayRoute).toContain("import { createDiscordGatewayRouteHandler } from \"@vite-hub/agent/server\"")
      expect(gatewayRoute).toContain("createDiscordGatewayRouteHandler")
      expect(gatewayRoute).toContain("VITEHUB_DISCORD_GATEWAY_SECRET")
      expect(gatewayRoute).toContain("VITEHUB_DISCORD_GATEWAY_DURATION_MS")
      expect(gatewayRoute).toContain("VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL")
      expect(gatewayRoute).toContain("function runtimeEnvValue(cloudflare, key)")
      expect(gatewayRoute).toContain("const cloudflare = cloudflareFromEvent(event)")
      expect(gatewayRoute).toContain("const secret = runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_SECRET')")
      expect(gatewayRoute).toContain("runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_DURATION_MS')")
      expect(gatewayRoute).toContain("runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL')")
      expect(gatewayRoute).toContain("const webhookRoute = \"/api/_vitehub/agents/:agent/webhooks/:webhook\"")
      expect(gatewayRoute).toContain("routePath(webhookRoute, { agent, webhook })")
      expect(gatewayRoute).toContain(".replace(/(^|\\/):([^/]+)/g")
      expect(gatewayRoute).toContain("process.env.NODE_ENV === 'development'")
      expect(gatewayRoute).toContain("Discord Gateway route requires VITEHUB_DISCORD_GATEWAY_SECRET.")
      expect(gatewayRoute).toContain("runtime: 'vite'")
      expect(gatewayRoute).toContain("waitUntil: waitUntilFromEvent(event)")
      expect(gatewayRoute).toContain("webhookUrl")
      expect(gatewayRoute).not.toContain("@vite-hub/schedule/runtime")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("injects the canonical Schedule runtime into generated hosted Agent routes", async () => {
    const { hubSchedule } = await import("../../schedule/src/vite.ts")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-schedule-routes-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { discordGateway: true } })
      const schedulePlugin = hubSchedule({ providerOutput: false })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, {
          command: "build",
          plugins: [schedulePlugin],
          root,
        } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")
      const gatewayRoute = await readFile(join(root, ".vitehub/agent/discord-gateway-route.ts"), "utf8")

      for (const route of [webhookRoute, gatewayRoute]) {
        expect(route).toContain('import vitehubAgentScheduleRegistry from "#vitehub/schedule/registry"')
        expect(route).toContain('setScheduleRuntimeRegistry as vitehubSetScheduleRuntimeRegistry } from "@vite-hub/schedule/runtime"')
        expect(route).toContain("vitehubSetScheduleRuntimeRegistry(vitehubAgentScheduleRegistry)")
        expect(route).toContain("const vitehubAgentRouteCapabilities = { schedule: { schedules: vitehubSchedules } }")
        expect(route).toContain("capabilities: vitehubAgentRouteCapabilities")
      }

      const denoPlugin = hubAgent({ runtime: "deno" })
      if (typeof denoPlugin.configResolved === "function") {
        await denoPlugin.configResolved.call({} as never, {
          plugins: [schedulePlugin],
          root,
        } as never)
      }
      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")
      expect(denoServer).toContain('import vitehubAgentScheduleRegistry from "./schedule-registry.js"')
      expect(denoServer).toContain("vitehubSetScheduleRuntimeRegistry(vitehubAgentScheduleRegistry)")
      expect(denoServer).toContain("capabilities: vitehubAgentRouteCapabilities")
      const standaloneRegistry = await readFile(join(root, ".vitehub/agent/schedule-registry.js"), "utf8")
      expect(standaloneRegistry).toContain('registry["agent/support"]')
      expect(standaloneRegistry).toContain('import("../../server/agents/support.ts")')

      process.env.VITEHUB_HOSTING = "netlify"
      const netlifyPlugin = hubAgent({ routes: { discordGateway: true } })
      if (typeof netlifyPlugin.configResolved === "function") {
        await netlifyPlugin.configResolved.call({} as never, {
          build: { outDir: "dist/client" },
          command: "build",
          plugins: [schedulePlugin],
          resolve: { alias: [] },
          root,
        } as never)
      }
      if (typeof netlifyPlugin.closeBundle === "object" && netlifyPlugin.closeBundle?.handler) {
        await netlifyPlugin.closeBundle.handler.call({} as never)
      }
      const netlifyFunction = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
      expect(netlifyFunction).toContain('import vitehubAgentScheduleRegistry from "./schedule-registry.js"')
      expect(netlifyFunction).toContain("vitehubSetScheduleRuntimeRegistry(vitehubAgentScheduleRegistry)")
      expect(netlifyFunction).toContain("capabilities: vitehubAgentRouteCapabilities")
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
      await rm(root, { force: true, recursive: true })
    }
  })

  it("bundles the configured Email definition in standalone Agent provider outputs", async () => {
    const { bundleEsmEntry } = await import("@vite-hub/internal/build/esbuild")
    const { hubEmail } = await import("../../email/src/vite.ts")
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-email-provider-routes-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const emailPlugin = hubEmail({ driver: "unemail/driver/resend" })
      if (typeof emailPlugin.configResolved === "function") {
        await emailPlugin.configResolved.call({} as never, { root } as never)
      }

      const denoPlugin = hubAgent({ runtime: "deno" })
      if (typeof denoPlugin.configResolved === "function") {
        await denoPlugin.configResolved.call({} as never, {
          command: "build",
          plugins: [emailPlugin, { name: "@vite-hub/database/vite" }],
          root,
        } as never)
      }
      const emailRuntime = await readFile(join(root, ".vitehub/agent/email-runtime.js"), "utf8")
      const emailDefinition = await readFile(join(root, ".vitehub/email/definition.mjs"), "utf8")
      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")
      expect(emailRuntime).toContain('import { createEmail } from "@vite-hub/email"')
      expect(emailRuntime).toContain('import definition from "../email/definition.mjs"')
      expect(emailRuntime).toContain("export const email = createEmail(definition)")
      expect(emailDefinition).toContain("api.resend.com")
      expect([emailRuntime, emailDefinition].join("\n")).not.toContain(root)
      expect([emailRuntime, emailDefinition].join("\n")).not.toMatch(/node_modules[/\\\\]/)
      expect(denoServer).toContain('import { email as vitehubEmail } from "./email-runtime.js"')
      expect(denoServer).not.toContain("@vite-hub/database/drizzle")
      const emailBundle = join(root, "email-runtime-bundle.mjs")
      await bundleEsmEntry(join(root, ".vitehub/agent/email-runtime.js"), emailBundle, {
        alias: { "@vite-hub/email": resolve(import.meta.dirname, "../../email/dist/index.js") },
        format: "esm",
        platform: "node",
        rootDir: root,
      })
      expect(await readFile(emailBundle, "utf8")).toContain("api.resend.com")

      process.env.VITEHUB_HOSTING = "netlify"
      const netlifyPlugin = hubAgent()
      if (typeof netlifyPlugin.configResolved === "function") {
        await netlifyPlugin.configResolved.call({} as never, {
          build: { outDir: "dist/client" },
          command: "build",
          plugins: [emailPlugin, { name: "@vite-hub/database/vite" }],
          resolve: { alias: [] },
          root,
        } as never)
      }
      if (typeof netlifyPlugin.closeBundle === "object" && netlifyPlugin.closeBundle?.handler) {
        await netlifyPlugin.closeBundle.handler.call({} as never)
      }
      const netlifyFunction = await readFile(join(root, ".vitehub/agent/netlify-function.mjs"), "utf8")
      expect(netlifyFunction).toContain('import { email as vitehubEmail } from "./email-runtime.js"')
      expect(netlifyFunction).not.toContain("@vite-hub/database/drizzle")
    }
    finally {
      if (typeof previousHosting === "string") process.env.VITEHUB_HOSTING = previousHosting
      else delete process.env.VITEHUB_HOSTING
      await rm(root, { force: true, recursive: true })
    }
  }, 15_000)

  it("installs hosted workspace runtime for generated Nitro agent routes with GitHub stores", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-github-workspace-route-"))
    try {
      await mkdir(join(root, "server", "agents", "support"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support", "agent.ts"), [
        "import { defineAgent } from '@vite-hub/agent'",
        "export default defineAgent({",
        "  driver: { async run() { return 'ok' } },",
        "  workspace: {",
        "    store: { provider: 'github', repository: 'onmax/bitacora-de-vida', root: '/' },",
        "  },",
        "})",
        "",
      ].join("\n"), "utf8")

      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("import { installHostedWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted\"")
      expect(webhookRoute).toContain("import { installHostedVercelBlobWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted-vercel-blob\"")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedVercelBlobWorkspaceStore)) installHostedVercelBlobWorkspaceRuntime()")
      expect(webhookRoute).not.toContain("@vite-hub/workspace/internal/stores/github")
      expect(webhookRoute).toContain("workspaceRegistryEntry(\"support\", agent0")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs automatic Cloudflare chat state for Cloudflare hosting", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const config = {
      build: {
        rolldownOptions: {
          external: ["existing"],
        },
        rollupOptions: {
          external: ["legacy"],
          input: "legacy-entry",
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
      preset: "cloudflare",
      root: hostedAgentRoot,
    }
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, config as never, { command: "build", mode: "production" })
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
    expect(output.nitro?.rollupConfig?.external).toEqual(["cloudflare:workers", ...optionalMessageAdapterRuntimeExternals])
    expect(output.nitro?.rollupConfig?.plugins?.some(plugin => plugin.name === "vitehub-agent-cloudflare-state-exports:ViteHubAgentStateDO")).toBe(true)
    expect(output.build).toEqual({
      rolldownOptions: {
        external: ["existing", ...optionalMessageAdapterRuntimeExternals],
        input: "legacy-entry",
      },
    })
    expect(config.build.rollupOptions).toBeUndefined()
  })

  it("uses a configured import in the Cloudflare Agent state Rollup entry", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({
      cloudflareStateImport: "vite-hub/_internal/agent/cloudflare/state",
    } as never)
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {
          preset: "cloudflare",
          root: hostedAgentRoot,
        } as never, { command: "build", mode: "production" })
      : undefined
    const output = result as {
      nitro?: {
        rollupConfig?: {
          plugins?: Array<{
            load?: (id: string) => string | undefined
            name?: string
            resolveId?: (id: string) => string | undefined
          }>
        }
      }
    }
    const statePlugin = output.nitro?.rollupConfig?.plugins?.find(plugin => plugin.name === "vitehub-agent-cloudflare-state-exports:ViteHubAgentStateDO")
    const resolvedId = statePlugin?.resolveId?.("virtual:vitehub-agent-cloudflare-state-exports")
    const source = resolvedId ? statePlugin?.load?.(resolvedId) : undefined

    expect(source).toContain('from "vite-hub/_internal/agent/cloudflare/state"')
    expect(source).not.toContain("@vite-hub/agent")
  })

  it("keeps automatic chat state host-neutral for Vercel hosting", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ routes: { chat: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {
          preset: "vercel",
          root: hostedAgentRoot,
        } as never, { command: "build", mode: "production" })
      : undefined
    const output = result as {
      nitro?: {
        cloudflare?: unknown
        handlers?: unknown[]
        rollupConfig?: unknown
      }
    }

    expect(output.nitro?.handlers).toContainEqual({
      handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/chat",
    })
    expect(output.nitro?.handlers).toContainEqual({
      handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    })
    expect(output.nitro?.cloudflare).toBeUndefined()
    expect(output.nitro?.rollupConfig).toBeUndefined()
  })

  it("prefers an explicit Vercel runtime over inferred Cloudflare hosting", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ runtime: "vercel" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {
          preset: "cloudflare",
          root: hostedAgentRoot,
        } as never, { command: "build", mode: "production" })
      : undefined

    expect((result as { nitro?: { cloudflare?: unknown } } | undefined)?.nitro?.cloudflare).toBeUndefined()
  })

  it("prefers explicit Cloudflare hosting over ambient Vercel CI", async () => {
    const previousVercel = process.env.VERCEL
    try {
      process.env.VERCEL = "1"
      const { hubAgent } = await import("../src/vite.ts")
      const plugin = hubAgent()
      const result = typeof plugin.config === "function"
        ? await plugin.config.call({} as never, {
            preset: "cloudflare",
            root: hostedAgentRoot,
          } as never, { command: "build", mode: "production" })
        : undefined

      expect((result as { nitro?: { cloudflare?: unknown } } | undefined)?.nitro?.cloudflare).toBeDefined()
    }
    finally {
      if (previousVercel === undefined) delete process.env.VERCEL
      else process.env.VERCEL = previousVercel
    }
  })

  it("detects automatic Cloudflare hosting from the build environment", async () => {
    const previousCloudflarePages = process.env.CF_PAGES
    try {
      process.env.CF_PAGES = "1"
      const { hubAgent } = await import("../src/vite.ts")
      const plugin = hubAgent()
      const result = typeof plugin.config === "function"
        ? await plugin.config.call({} as never, {
            root: hostedAgentRoot,
          } as never, { command: "build", mode: "production" })
        : undefined

      expect((result as { nitro?: { cloudflare?: unknown } } | undefined)?.nitro?.cloudflare).toBeDefined()
    }
    finally {
      if (previousCloudflarePages === undefined) delete process.env.CF_PAGES
      else process.env.CF_PAGES = previousCloudflarePages
    }
  })

  it("keeps Cloudflare chat state opt-out when the state provider is memory", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ providers: { state: { provider: "memory" } }, routes: { chat: true } })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, { root: hostedAgentRoot }, { command: "build", mode: "production" })
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
      handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/chat",
    })
    expect(output.nitro?.handlers).toContainEqual({
      handler: join(hostedAgentRoot, ".vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    })
    expect(output.nitro?.cloudflare).toBeUndefined()
    expect(output.nitro?.rollupConfig).toBeUndefined()
    expect(output.build).toEqual({
      rolldownOptions: { external: optionalMessageAdapterRuntimeExternals },
    })
  })

  it("skips Nitro handlers for Deno generated output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ runtime: "deno" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      agent: { runtime: "deno" },
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
      const plugin = hubAgent({ runtime: "deno" })
      const configResolved = plugin.configResolved as (config: { agent?: unknown, command: "build", root: string }) => Promise<void>
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
      vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

      await configResolved({ agent: { runtime: "deno" }, command: "build", root })
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
      await mkdir(join(root, "server", "agents", "support"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default {}", "utf8")
      await writeFile(join(root, "server", "agents", "support", "instructions.md"), "Use support instructions.\n", "utf8")
      const plugin = hubAgent({ routes: { chat: true } })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "serve", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("createChannelChatRouteHandler")
      expect(webhookRoute).toContain("withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule")
      expect(webhookRoute).toContain('agentWithColocatedInstructions(resolveAgentModule(agent0), "Use support instructions.\\n")')
      expect(webhookRoute).not.toContain("withAgentDefaults")
      expect(webhookRoute).toContain("const agentIdentities")
      expect(webhookRoute).toContain('"support": {"name":"support"}')
      expect(webhookRoute).not.toContain("import { createCloudflareAgentState } from \"@vite-hub/agent/cloudflare\"")
      expect(webhookRoute).toContain("async function toRequest(event: H3Event)")
      expect(webhookRoute).toContain("const body = await readRawBody(event)")
      expect(webhookRoute).not.toContain("return event.request")
      expect(webhookRoute).toContain("function waitUntilFromEvent(event: H3Event)")
      expect(webhookRoute).not.toContain("function chatStateFromCloudflare(cloudflare:")
      expect(webhookRoute).toContain("function resolveChatRouteOptions(module:")
      expect(webhookRoute).toContain("waitUntil: waitUntilFromEvent(event)")
      expect(webhookRoute).not.toContain("state: chatStateFromCloudflare(cloudflare)")
      expect(webhookRoute).toContain("runtime: 'vite'")
      expect(webhookRoute).toContain("const agentModules: Record<string, AgentRegistryModule & { chatRoute?: unknown }>")
      expect(webhookRoute).toContain("const chatHandlers")
      expect(webhookRoute).toContain("filter(([, agent]) => hasChannelChatRoute(agent))")
      expect(webhookRoute).toContain("createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))")
      expect(webhookRoute).toContain("const webhookHandlers")
      expect(webhookRoute).toContain("const webhookRoutePattern")
      expect(webhookRoute).toContain("const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)")
      expect(webhookRoute).toContain("return await handler(await toRequest(event), webhook")
      expect(webhookRoute).toContain("return await handler(await toRequest(event), { agentIdentity: agentIdentities[agent], cloudflare, runtime: 'vite', event, waitUntil: waitUntilFromEvent(event) })")
      expect(webhookRoute).not.toContain("@vite-hub/schedule/runtime")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes generated Nitro handlers that compile under strict TypeScript", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(import.meta.dirname, ".vitehub-agent-routes-types-"))
    try {
      await mkdir(join(root, "server", "agents", "calories"), { recursive: true })
      await writeFile(join(root, "server", "agents", "calories", "agent.ts"), `
import { defineAgent } from "@vite-hub/agent"
import { telegram } from "@vite-hub/agent/channels"

export default defineAgent({
  channels: {
    telegram: telegram({
      adapter: () => ({}) as never,
      messages: {
        concurrency: "parallel",
        stream: true,
      },
      webhooks: { id: "telegram", secretToken: false },
    }),
  },
  driver: {
    run: async () => undefined,
  },
})
`, "utf8")
      await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
        extends: resolve(import.meta.dirname, "../tsconfig.json"),
        include: [
          ".vitehub/agent/chat-webhook-route.ts",
          "server/agents/**/*.ts",
        ],
      }, null, 2)}\n`, "utf8")

      for (const stateProvider of ["cloudflare", "libsql"] as const) {
        const plugin = hubAgent(stateProvider === "libsql"
          ? { providers: { state: { provider: "libsql", url: "libsql://state.example.test" } } }
          : undefined)
        if (typeof plugin.configResolved === "function") {
          await plugin.configResolved.call({} as never, { command: "build", preset: "cloudflare", root } as never)
        }

        const generatedRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")
        expect(generatedRoute).not.toContain("@ts-nocheck")
        if (stateProvider === "libsql") {
          expect(generatedRoute).toContain("let viteHubChatState: ReturnType<typeof createLibsqlAgentState> | undefined")
        }
        await execFileAsync(process.execPath, [
          resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc"),
          "--noEmit",
          "-p",
          join(root, "tsconfig.json"),
        ], { cwd: root }).catch((error: { stderr?: string, stdout?: string }) => {
          throw new Error([error.stdout, error.stderr].filter(Boolean).join("\n"))
        })
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("writes generated Cloudflare state helpers for Cloudflare hosting", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-cloudflare-state-routes-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", preset: "cloudflare", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("import { createCloudflareAgentState } from \"@vite-hub/agent/cloudflare\"")
      expect(webhookRoute).not.toContain("createChannelChatRouteHandler")
      expect(webhookRoute).toContain("const chatHandlers = {}")
      expect(webhookRoute).toContain("function chatStateFromCloudflare(cloudflare:")
      expect(webhookRoute).toContain("state: chatStateFromCloudflare(cloudflare)")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes local SQLite state in Vite development with a Cloudflare production preset", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-local-state-routes-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    try {
      delete process.env.VITEHUB_HOSTING
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent()
      const result = typeof plugin.config === "function"
        ? await plugin.config.call({} as never, { preset: "cloudflare", root } as never, { command: "serve", mode: "development" })
        : undefined
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "serve", preset: "cloudflare", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect((result as { nitro?: { cloudflare?: unknown } } | undefined)?.nitro?.cloudflare).toBeUndefined()
      expect(webhookRoute).toContain("import { createLibsqlAgentState } from \"@vite-hub/agent/state/sqlite\"")
      expect(webhookRoute).toContain(`const viteHubChatStateOptions = {"url":${JSON.stringify(pathToFileURL(join(root, ".data/vitehub-agent-state.sqlite")).href)}}`)
      expect(webhookRoute).toContain("const runtimeUrl = typeof process === 'object' ? process.env.VITEHUB_AGENT_STATE_URL : undefined")
      expect(webhookRoute).not.toContain("Agent state requires a durable VITEHUB_AGENT_STATE_URL")
    }
    finally {
      if (previousHosting === undefined) delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
      await rm(root, { force: true, recursive: true })
    }
  })

  it("requires durable automatic state on deployed Vercel output", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-vercel-state-routes-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", preset: "vercel", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("const viteHubChatStateOptions = {}")
      expect(webhookRoute).toContain("Agent state requires a durable VITEHUB_AGENT_STATE_URL for this deployment")
      expect(webhookRoute).toContain("Agent state cannot use a file: URL on vercel because its filesystem is ephemeral")
      expect(webhookRoute).toContain("state: viteHubChatStateResolver")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects explicit file state on deployed ephemeral hosts", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-ephemeral-file-state-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ providers: { state: { provider: "sqlite", url: "file:.data/state.sqlite" } } })
      if (typeof plugin.configResolved !== "function") throw new TypeError("Expected Agent configResolved hook.")

      await expect(plugin.configResolved.call({} as never, {
        command: "build",
        preset: "netlify",
        root,
      } as never)).rejects.toThrow("Agent state cannot use a file: URL on netlify")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects file state for an explicit ephemeral runtime without hosting metadata", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-explicit-ephemeral-state-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({
        providers: { state: { provider: "sqlite", url: "file:.data/state.sqlite" } },
        runtime: "vercel",
      })
      if (typeof plugin.configResolved !== "function") throw new TypeError("Expected Agent configResolved hook.")

      await expect(plugin.configResolved.call({} as never, {
        command: "build",
        root,
      } as never)).rejects.toThrow("Agent state cannot use a file: URL on vercel")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("writes generated Nitro webhook handlers with sqlite state providers", async () => {
    const { hubAgent } = await import("../src/vite.ts")

    for (const provider of ["sqlite", "libsql"] as const) {
      const root = await mkdtemp(join(tmpdir(), `vitehub-agent-${provider}-state-routes-`))
      try {
        vi.stubEnv("TURSO-AUTH-TOKEN", "build-token-with-hyphen-env")
        await mkdir(join(root, "server", "agents"), { recursive: true })
        await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
        const plugin = hubAgent({
          providers: {
            state: {
              authToken: "build-token-with-hyphen-env",
              provider,
              tablePrefix: "agent_state_",
              url: "file:build-state.sqlite",
            },
          },
        })
        if (typeof plugin.configResolved === "function") {
          await plugin.configResolved.call({} as never, { command: "build", root } as never)
        }

        const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")
        const queuePlugin = await readFile(join(root, ".vitehub/agent/webhook-queue-plugin.ts"), "utf8")

        expect(webhookRoute).toContain("import { createLibsqlAgentState } from \"@vite-hub/agent/state/sqlite\"")
        expect(webhookRoute).not.toContain("import { createCloudflareAgentState }")
        expect(webhookRoute).toContain("const viteHubChatStateOptions = {\"tablePrefix\":\"agent_state_\",\"url\":\"file:build-state.sqlite\"}")
        expect(webhookRoute).not.toContain("build-token-with-hyphen-env")
        expect(webhookRoute).toContain("let viteHubChatState")
        expect(webhookRoute).toContain("viteHubChatState = createLibsqlAgentState({")
        expect(webhookRoute).toContain("viteHubChatStateResolver.ownsScope = false")
        expect(webhookRoute).toContain("process.env[\"TURSO-AUTH-TOKEN\"]")
        expect(webhookRoute).not.toContain("process.env.TURSO-AUTH-TOKEN")
        expect(webhookRoute).toContain("process.env.VITEHUB_AGENT_STATE_AUTH_TOKEN")
        expect(webhookRoute).toContain("process.env.VITEHUB_AGENT_STATE_URL")
        expect(webhookRoute).toContain("function chatStateFromLibsql()")
        expect(webhookRoute).toContain("export function resumeWebhookQueues(waitUntil: AgentWaitUntil | undefined)")
        expect(webhookRoute).toContain("if (!runtimeUrl && !viteHubChatStateOptions.url) return async () => undefined")
        expect(webhookRoute).toContain("handler.resume({ agentIdentity: agentIdentities[name], webhookState: viteHubChatStateResolver, waitUntil })")
        expect(webhookRoute).toContain("return async () => await Promise.all(stops.map(stop => stop()))")
        expect(queuePlugin).toContain("import { resumeWebhookQueues, waitUntilFromEvent } from \"./chat-webhook-route\"")
        expect(queuePlugin).toContain("nitroApp.hooks.hook('request', event => {")
        expect(queuePlugin).toContain("waitUntil ||= waitUntilFromEvent(event)")
        expect(queuePlugin).toContain("stopping ||= stop?.()")
        expect(queuePlugin).toContain("if (stopping) waitUntil?.(stopping)")
        expect(queuePlugin).toContain("nitroApp.hooks.hook('close', shutdownWebhookQueues)")
        expect(queuePlugin).toContain("shutdownSignals = ['SIGINT', 'SIGTERM'].filter(signal => nodeProcess?.listenerCount(signal))")
        expect(queuePlugin).toContain("nodeProcess?.prependOnceListener(signal, shutdownWebhookQueues)")
        expect(queuePlugin).not.toContain("process.exit")
        expect(webhookRoute).toContain("return await handler(await toRequest(event), webhook, { agentIdentity: agentIdentities[agent], cloudflare, state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, waitUntil: waitUntilFromEvent(event) })")
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    }
  })

  it("lets built generated Nitro handlers detect the host runtime", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-routes-build-runtime-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).not.toContain("runtime: 'vite'")
      expect(webhookRoute).toContain("return await handler(await toRequest(event), webhook, { agentIdentity: agentIdentities[agent], cloudflare, state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, waitUntil: waitUntilFromEvent(event) })")
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
      await writeFile(join(root, "server", "agents", "audio-bitacora", "agent.ts"), [
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
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("import { installHostedWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted\"")
      expect(webhookRoute).toContain("import { installHostedVercelBlobWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted-vercel-blob\"")
      expect(webhookRoute).toContain("function hasHostedWorkspaceStore(module)")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedVercelBlobWorkspaceStore)) installHostedVercelBlobWorkspaceRuntime()")
      expect(webhookRoute).toContain("setWorkspaceRuntimeRegistry(Object.fromEntries([")
      expect(webhookRoute).toContain("workspaceRegistryEntry(\"audio-bitacora\", agent0")
      expect(webhookRoute).toContain('"audio-bitacora": {"name":"audio-bitacora","workspace":"audio-bitacora"}')
      expect(webhookRoute).not.toContain("withAgentDefaults")
      expect(webhookRoute).not.toContain("@vite-hub/workspace/internal/stores/github")
      expect(webhookRoute).not.toContain("configureCloudflareWorkspaceRuntime")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs hosted workspace runtime setup for Agent workspaces resolved from Vercel Blob env", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-implicit-vercel-blob-workspace-route-"))
    try {
      await mkdir(join(root, "server", "agents", "audio-bitacora"), { recursive: true })
      await writeFile(join(root, "server", "agents", "audio-bitacora", "agent.ts"), [
        "import { defineAgent } from '@vite-hub/agent'",
        "export default defineAgent({",
        "  workspace: {",
        "    mode: 'write',",
        "  },",
        "  async run() { return 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "build", root } as never)
      }

      const webhookRoute = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")

      expect(webhookRoute).toContain("import { installHostedWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted\"")
      expect(webhookRoute).toContain("import { installHostedVercelBlobWorkspaceRuntime } from \"@vite-hub/workspace/internal/runtime/hosted-vercel-blob\"")
      expect(webhookRoute).toContain("process?.env?.BLOB_READ_WRITE_TOKEN")
      expect(webhookRoute).toContain("if ([agent0].some(hasHostedVercelBlobWorkspaceStore)) installHostedVercelBlobWorkspaceRuntime()")
      expect(webhookRoute).toContain("setWorkspaceRuntimeRegistry(Object.fromEntries([")
      expect(webhookRoute).toContain("workspaceRegistryEntry(\"audio-bitacora\", agent0")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("publishes Deno chat routes only when configured", async () => {
    const { hubAgent } = await import("../src/vite.ts")

    for (const testCase of [
      { chat: undefined, expectedPattern: "(?!)" },
      { chat: false, expectedPattern: "(?!)" },
      { chat: true, expectedPattern: "^/api/_vitehub/agents/(?<agent>[^/]+)/chat$" },
      { chat: "/chat/[agent]", expectedPattern: "^/chat/(?<agent>[^/]+)$" },
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-chat-route-"))
      try {
        await mkdir(join(root, "server", "agents"), { recursive: true })
        await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
        const routes = testCase.chat === undefined ? undefined : { chat: testCase.chat }
        const plugin = hubAgent({ routes, runtime: "deno" } as never)
        if (typeof plugin.configResolved === "function") {
          await plugin.configResolved.call({} as never, { root } as never)
        }

        const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")
        expect(denoServer).toContain(`const chatRoutePattern = new RegExp(${JSON.stringify(testCase.expectedPattern)})`)
        expect(denoServer).toContain("const webhookRoutePattern = new RegExp(\"^/api/_vitehub/agents/(?<agent>[^/]+)/webhooks/(?<webhook>[^/]+)$\")")
        if (testCase.chat) {
          expect(denoServer).toContain("createChannelChatRouteHandler")
        }
        else {
          expect(denoServer).not.toContain("createChannelChatRouteHandler")
          expect(denoServer).toContain("const chatHandlers = {}")
        }
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    }
  })

  it("writes generated Deno server output for chat and webhook routes", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deno-routes-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
      const plugin = hubAgent({ routes: { chat: true }, runtime: "deno" })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")

      expect(denoServer).toContain("import { createChannelChatRouteHandler, createChannelWebhookRouteHandler, hasChannelChatRoute } from \"@vite-hub/agent/server/internal\"")
      expect(denoServer).not.toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/workspace/runtime\"")
      expect(denoServer).toContain('await import("../schedule/deno-cron.mjs").catch')
      expect(denoServer).toContain("const chatRoutePattern = new RegExp(\"^/api/_vitehub/agents/(?<agent>[^/]+)/chat$\")")
      expect(denoServer).toContain("const webhookRoutePattern = new RegExp(\"^/api/_vitehub/agents/(?<agent>[^/]+)/webhooks/(?<webhook>[^/]+)$\")")
      expect(denoServer).toContain("import { createLibsqlAgentState } from \"@vite-hub/agent/state/sqlite\"")
      expect(denoServer).toContain("let viteHubChatState: ReturnType<typeof createLibsqlAgentState> | undefined")
      expect(denoServer).toContain("return isWebhookRoute ? await handler(request, webhook, { agentIdentity: agentIdentities[agent], state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver }) : await handler(request, { agentIdentity: agentIdentities[agent], state: viteHubChatStateResolver })")
      expect(denoServer).not.toContain("@vite-hub/schedule/runtime")
      expect(denoServer).toContain("function resolveDenoServeOptions(args)")
      expect(denoServer).toContain("const serveOptions = resolveDenoServeOptions(Deno.args)")
      expect(denoServer).toContain("const stopWebhookQueues = resumeWebhookQueues()")
      expect(denoServer).toContain("const server = serveOptions ? Deno.serve(serveOptions, handleRequest) : Deno.serve(handleRequest)")
      expect(denoServer).toContain("await server.finished")
      expect(denoServer).toContain("await stopWebhookQueues()")
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
      await mkdir(join(root, "server", "agents", "support", "skills", "review", "scripts"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support", "agent.ts"), [
        "import { defineAgent } from '@vite-hub/agent'",
        "export default defineAgent({",
        "  workspace: {},",
        "  async run() { return 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      await writeFile(join(root, "server", "agents", "support", "instructions.md"), "Use support instructions.\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "workspace", "instructions.md"), "Do not use workspace instructions.\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "skills", "review", "SKILL.md"), "# Review\n", "utf8")
      await writeFile(join(root, "server", "agents", "support", "skills", "review", "scripts", "review.bin"), Uint8Array.from([0, 255, 42]))
      const plugin = hubAgent({ runtime: "deno" })
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { root } as never)
      }

      const denoServer = await readFile(join(root, ".vitehub/agent/deno-server.ts"), "utf8")

      expect(denoServer).toContain("import { setWorkspaceRuntimeRegistry } from \"@vite-hub/workspace/runtime\"")
      expect(denoServer).toContain("workspaceAgentOwnsWorkspaceDefinition")
      expect(denoServer).toContain("withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule(agent0)")
      expect(denoServer).toContain("workspaceRegistryEntry(\"support\", agent0")
      expect(denoServer).toContain("__vitehubAgentInstructions")
      expect(denoServer).toContain("content: colocatedInstructions")
      expect(denoServer).toContain("Symbol.for('vitehub.agent.colocatedSkills')")
      expect(denoServer).toContain("Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent))")
      expect(denoServer).toContain("Uint8Array.from(atob(content)")
      expect(denoServer).toContain(JSON.stringify("__vitehubAgentSkill:skills/review/SKILL.md"))
      expect(denoServer).toContain(JSON.stringify(Buffer.from([0, 255, 42]).toString("base64")))
      expect(denoServer).toContain("const existingSources = resolvedAgent.sources && typeof resolvedAgent.sources === 'object' ? resolvedAgent.sources : undefined")
      expect(denoServer).toContain("    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }")
      expect(denoServer).toContain("workspaceDefinitionFromOptions")
      expect(denoServer).toContain("const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }")
      expect(denoServer).toContain("const decoratedAgent = { ...resolvedAgent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }")
      expect(denoServer).toContain("Object.defineProperty(decoratedAgent, key, Object.getOwnPropertyDescriptor(resolvedAgent, key)!)")
      expect(denoServer).toContain("return decoratedAgent as unknown as Agent")
      expect(denoServer).toContain(`${JSON.stringify(join(root, "server", "agents", "support", "workspace"))}, "Use support instructions.\\n", {`)
      expect(denoServer).not.toContain("Do not use workspace instructions.")
      expect(denoServer).toContain("setWorkspaceRuntimeRegistry(Object.fromEntries([")
      expect(denoServer).not.toContain("\"support\": async ()")
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

  it("does not publish built-in Agent Driver factory subpaths", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>
    }

    expect(pkg.exports?.["./harness/codex"]).toBeUndefined()
    expect(pkg.exports?.["./harness/claude-code"]).toBeUndefined()
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

  it("keeps the optional Schedule peer out of the generated Agent handler subpath", async () => {
    const built = await readFile(new URL("../dist/server/internal.js", import.meta.url), "utf8")
    const declaration = await readFile(new URL("../dist/server/internal.d.ts", import.meta.url), "utf8")

    expect(built).not.toMatch(/\bfrom ["']@vite-hub\/schedule(?:["'/])/)
    expect(declaration).not.toMatch(/\bfrom ["']@vite-hub\/schedule(?:["'/])/)
  })

  it("keeps esbuild external in the Agent Vite plugin package build", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8")
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
    }

    expect(config).toContain('"esbuild"')
    expect(pkg.dependencies?.esbuild).toBe("catalog:esbuild-v27")
  })

  it("publishes Schedule as an optional Agent integration peer", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(pkg.dependencies?.["@vite-hub/schedule"]).toBeUndefined()
    expect(pkg.devDependencies?.["@vite-hub/schedule"]).toBe("workspace:*")
    expect(pkg.peerDependencies?.["@vite-hub/schedule"]).toBe("workspace:*")
    expect(pkg.peerDependenciesMeta?.["@vite-hub/schedule"]).toEqual({ optional: true })
  })

  it("publishes only required root runtime peers", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
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
    expect(pkg.peerDependencies?.["@vite-hub/workflow"]).toBe("workspace:*")
    expect(pkg.peerDependencies?.["@vercel/functions"]).toBe("catalog:vercel")
    expect(pkg.peerDependencies?.askweb).toBe("catalog:ai")
    expect(pkg.peerDependencies?.evalite).toBeUndefined()
    expect(pkg.peerDependencies?.vitest).toBe("catalog:tooling")
    expect(pkg.peerDependenciesMeta?.agents).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.["@vite-hub/workflow"]).toEqual({ optional: true })
    expect(pkg.peerDependenciesMeta?.["@vercel/functions"]).toEqual({ optional: true })
    expect(pkg.peerDependenciesMeta?.askweb).toEqual({ optional: true })
    expect(pkg.peerDependenciesMeta?.evalite).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.vitest).toEqual({ optional: true })
    expect(pkg.dependencies?.["@ai-sdk/harness"]).toBe("catalog:ai")
    expect(pkg.dependencies?.["@ai-sdk/harness-codex"]).toBe("catalog:ai")
    expect(pkg.devDependencies?.["@ai-sdk/harness-codex"]).toBeUndefined()
    expect(pkg.peerDependencies?.["@ai-sdk/harness"]).toBeUndefined()
    expect(pkg.peerDependencies?.["@ai-sdk/harness-claude-code"]).toBe("catalog:ai")
    expect(pkg.peerDependencies?.["@ai-sdk/harness-codex"]).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.["@ai-sdk/harness"]).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.["@ai-sdk/harness-codex"]).toBeUndefined()
    expect(pkg.dependencies?.ai).toBe("catalog:ai")
    expect(pkg.peerDependencies?.ai).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.ai).toBeUndefined()
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
      const { defineAgent, runAgentInline } = await import("../src/index.ts")
      const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
      const { defineWorkspace, file, useWorkspace } = await import("@vite-hub/workspace")
      const agent = defineAgent({
        driver: { async run({ workspace }) {
            return await (workspace as { fs: { readFile(path: string): Promise<string> } }).fs.readFile("AGENTS.md")
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

      expect(preparedAgent).toBe(agent)
      expect(preparedAgent).not.toHaveProperty("__vitehubWorkspaceAgentDefaults")
      expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Support\n")
      await expect(runAgentInline(preparedAgent, {
        agentIdentity: { name: "support", workspace: "support-runtime" },
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})).resolves.toBe("# Support\n")
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

  it("consumes only approval responses issued by the server session", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-approval-"))
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const { createAgentUIMessageStreamResponse } = await import("../src/stream-output.ts")
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(({ input, messages }) => {
      const hasApproval = messages.some((message: { parts?: Array<{ type?: string }> }) => message.parts?.some(part => part.type === "approval-decision"))
      if (hasApproval) {
        expect(messages[0]?.parts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "call-1", input: { path: "README.md" }, name: "github__createOrUpdateFile", type: "tool-call" }),
          expect.objectContaining({ id: "approval-1", toolCallId: "call-1", type: "approval-request" }),
          expect.objectContaining({ approved: true, id: "approval-1", type: "approval-decision" }),
        ]))
      }
      return input.context?.["vitehub.eve.approvedTools"] ? "approved" : "fresh"
    })
    const approvalResponse = createAgentUIMessageStreamResponse({
      headers: { "x-agent": "approval" },
      status: 201,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ messageId: "assistant-1", type: "start" })
          controller.enqueue({ input: { path: "README.md" }, toolCallId: "call-1", toolName: "github__createOrUpdateFile", type: "tool-input-available" })
          controller.enqueue({ approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" })
          controller.enqueue({ finishReason: "tool-calls", type: "finish" })
          controller.close()
        },
      }),
    })
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockResolvedValueOnce({
      body: approvalResponse.body,
      headers: approvalResponse.headers,
      status: approvalResponse.status,
      statusText: approvalResponse.statusText,
    } as never)
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability({ sessions: { idleTimeoutMs: 60_000, strategy: "hybrid" } })],
      driver: { run },
      invoker: {
        resolve: ({ request }) => ({ id: request?.headers.get("x-user") || "anonymous" }),
      },
    }) as never, {
      admission: { authenticate: () => true },
      input: { trust: ["session"] },
    })
    const request = (approvalId?: string, user = "user-1", sessionId = "session-1", includeLaterMessage = false, approved = true) => new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: approvalId
          ? [{
              id: "assistant-1",
              parts: [{
                approval: { approved, id: approvalId },
                input: { path: "forged.md" },
                state: "approval-responded",
                toolCallId: "forged-call",
                toolName: "forged-tool",
                type: "dynamic-tool",
              }],
              role: "assistant",
            }, ...(includeLaterMessage ? [{ id: "user-2", parts: [{ text: "continue", type: "text" }], role: "user" }] : [])]
          : [{ id: "user-1", parts: [{ text: "update the file", type: "text" }], role: "user" }],
        session: { action: approvalId ? "continue" : "new", id: sessionId },
      }),
      headers: { "content-type": "application/json", "x-user": user },
      method: "POST",
    })

    try {
      const stateSet = vi.spyOn(state, "set")
      const requested = await handler(request(), { agentName: "support", state })
      expect(requested.status).toBe(201)
      expect(requested.headers.get("x-agent")).toBe("approval")
      await requested.text()
      expect(stateSet).toHaveBeenCalledWith(
        expect.stringMatching(/:approval:approval-1$/),
        expect.objectContaining({ id: "approval-1", toolCallId: "call-1" }),
        60_000,
      )
      stateSet.mockClear()

      const otherUser = await handler(request("approval-1", "user-2"), { agentName: "support", state })
      expect(otherUser.status).toBe(400)
      expect(run).not.toHaveBeenCalled()

      const otherSession = await handler(request("approval-1", "user-1", "session-2"), { agentName: "support", state })
      expect(otherSession.status).toBe(400)
      expect(run).not.toHaveBeenCalled()

      const approved = await handler(request("approval-1"), { agentName: "support", state })
      expect(approved.status).toBe(200)
      await expect(approved.text()).resolves.toContain("approved")
      expect(stateSet).toHaveBeenCalledWith(
        expect.stringMatching(/^chat:support:http:invoker:user-1:session:.*:manual:session-1:boundary$/),
        expect.stringMatching(/^session-1:manual:[A-Za-z0-9_-]+$/),
        60_000,
      )
      expect(stateSet).not.toHaveBeenCalledWith(
        expect.any(String),
        "session-1:manual:user-1",
        expect.any(Number),
      )
      expect(stateSet).toHaveBeenCalledWith(
        expect.stringMatching(/:eve:approved-tools$/),
        ["github__createOrUpdateFile"],
        60_000,
      )
      expect(stateSet).toHaveBeenCalledWith(
        expect.stringMatching(/:approval:approval-1:consumed$/),
        expect.objectContaining({ approved: true, id: "approval-1", toolCallId: "call-1" }),
        60_000,
      )
      expect(run.mock.calls[0]?.[0].input.context?.["vitehub.eve.approvedTools"]).toEqual(["github__createOrUpdateFile"])

      const continued = await handler(request("approval-1", "user-1", "session-1", true, false), { agentName: "support", state })
      expect(continued.status).toBe(200)
      await expect(continued.text()).resolves.toContain("approved")

      const expiredHistorical = await handler(request("expired-approval", "user-1", "session-1", true), { agentName: "support", state })
      const expiredBody = await expiredHistorical.text()
      expect({ body: expiredBody, status: expiredHistorical.status }).toEqual({ body: expect.stringContaining("approved"), status: 200 })

      const freshSession = await handler(request(undefined, "user-1", "session-2"), { agentName: "support", state })
      expect(freshSession.status).toBe(200)
      await expect(freshSession.text()).resolves.toContain("fresh")
      expect(run.mock.calls[3]?.[0].input.context?.["vitehub.eve.approvedTools"]).toBeUndefined()

      const replayed = await handler(request("approval-1"), { agentName: "support", state })
      expect(replayed.status).toBe(400)
      expect(run).toHaveBeenCalledTimes(4)
    }
    finally {
      streamAgentTrigger.mockRestore()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("does not reuse durable Eve approvals for anonymous HTTP callers", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-anonymous-chat-approval-"))
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(({ input }) => input.context?.["vitehub.eve.approvedTools"] ? "approved" : "fresh")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: { run },
    }) as never, {
      admission: { authenticate: () => true },
      input: { trust: ["session"] },
    })
    const approvalSessionId = "http:support:portal-thread:chat-session:session-1"
    const key = `invoker:${encodeURIComponent("anonymous:http")}:session:${encodeURIComponent(approvalSessionId)}:eve:approved-tools`
    const pendingApprovalKey = `invoker:${encodeURIComponent("anonymous:http")}:session:${encodeURIComponent(approvalSessionId)}:approval:shared-approval`

    try {
      await state.connect()
      await state.set(key, ["github__createOrUpdateFile"])
      await state.set(pendingApprovalKey, {
        id: "shared-approval",
        name: "github__createOrUpdateFile",
        toolCallId: "call-1",
      })
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify({
          id: "portal-thread",
          messages: [{ id: "user-1", parts: [{ text: "continue", type: "text" }], role: "user" }],
          session: { id: "session-1" },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }), { agentName: "support", state })

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toContain("fresh")
      expect(run.mock.calls[0]?.[0].input.context?.["vitehub.eve.approvedTools"]).toBeUndefined()

      const approvalResponse = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify({
          id: "portal-thread",
          messages: [{
            parts: [{
              approval: { approved: true, id: "shared-approval" },
              state: "approval-responded",
              type: "dynamic-tool",
            }],
            role: "assistant",
          }],
          session: { id: "session-1" },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }), { agentName: "support", state })
      expect(approvalResponse.status).toBe(400)
      expect(run).toHaveBeenCalledOnce()
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("uses an explicit Runtime Schedule primitive through chat route contexts", async () => {
    const createdAt = new Date("2026-07-12T00:00:00.000Z")
    const schedules = {
      create: vi.fn(async input => ({
        ...input,
        createdAt,
        enabled: input.enabled ?? true,
        id: input.id || "created",
        updatedAt: createdAt,
      })),
      delete: vi.fn(),
      disable: vi.fn(),
      enable: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => []),
      run: vi.fn(),
      update: vi.fn(),
    }
    const { defineAgent } = await import("../src/index.ts")
    const { schedule } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const agent = defineAgent({
      capabilities: [
        defineChatCapability(),
        schedule({
          allowSelfTarget: true,
          delivery: "origin",
          mode: "write",
          timeZone: "Asia/Bangkok",
        }),
      ],
      driver: {
        async run({ tools }) {
          const record = await tools!.cronjob!.execute?.({
            cron: "0 9 * * *",
            id: "daily-0900",
            operation: "create",
            prompt: "Send my daily report.",
          }) as { id: string }
          return `scheduled ${record.id}`
        },
      },
    })
    const handler = createChannelChatRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/mini/chat", {
      body: JSON.stringify({
        id: "daily-thread",
        messages: [{
          id: "user-1",
          parts: [{ text: "remind me every day", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentIdentity: { name: "mini" }, capabilities: { schedule: { schedules } } })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: "INTERNAL", error: "Agent request failed." })
    expect(schedules.create).not.toHaveBeenCalled()
  })

  it("keeps manual chat route Schedule primitives explicit", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { schedule } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability(), schedule({ mode: "read" })],
      driver: { run: () => "unused" },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/mini/chat", {
      body: JSON.stringify({
        messages: [{
          id: "user-1",
          parts: [{ text: "list reminders", type: "text" }],
          role: "user",
        }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { agentName: "mini" })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: "INTERNAL", error: "Agent request failed." })
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

  it("accepts UI message streams and Responses from another runtime realm", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ textDelta: "hello", type: "text-delta" })
        controller.close()
      },
    })
    const foreignStream = {
      getReader: stream.getReader.bind(stream),
      pipeThrough: stream.pipeThrough.bind(stream),
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
    }
    const responseHeaders = new Headers({
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
    })
    const foreignResponse = {
      body: new Response("data: {\"type\":\"finish\"}\n\n").body,
      headers: {
        entries: responseHeaders.entries.bind(responseHeaders),
        get: responseHeaders.get.bind(responseHeaders),
      },
      status: 202,
      statusText: "Accepted",
    }
    expect(foreignStream).not.toBeInstanceOf(ReadableStream)
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger")
      .mockResolvedValueOnce(foreignStream as never)
      .mockResolvedValueOnce(foreignResponse as never)
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: { run: () => "unused" },
    }) as never)
    const request = () => new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({ messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }] }),
      method: "POST",
    })

    const streamResponse = await handler(request(), { agentName: "support" })
    expect(streamResponse.status).toBe(200)
    await expect(streamResponse.text()).resolves.toContain('"textDelta":"hello"')

    const response = await handler(request(), { agentName: "support" })
    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe("data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n")
    streamAgentTrigger.mockRestore()
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

  it("serves default webChat routes with channel-owned trusted input mapping", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context, invoker, run }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, user?: { email?: string } } | undefined
      return `portal ${run.channelId} ${run.origin} ${run.threadId} ${invoker.id} ${chatContext?.user?.email} ${chatContext?.meta?.audience}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
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

  it("uses route Channel chat state for webChat approvals", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-chat-state-"))
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const resolveState = vi.fn(() => state)
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({ messages: { state: resolveState } }),
      },
      driver: { run: () => "ok" },
    }) as never, { channelId: "portal" })

    try {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify({
          messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }), { agentName: "support" })

      expect(response.status).toBe(200)
      expect(resolveState).toHaveBeenCalledOnce()
      expect(resolveState).toHaveBeenCalledWith(expect.objectContaining({
        chat: expect.objectContaining({ agentName: "support" }),
      }))
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
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
    const hostEvent = { context: { tenant: "acme" } }
    const authenticate = vi.fn(({ event, rawBody, request }) => {
      expect(event).toBe(hostEvent)
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
              context({ auth, body, event }) {
                expect(event).toBe(hostEvent)
                return {
                  invokerProfileId: auth.invokerProfileId,
                  meta: body.meta,
                  run: { origin: "portal" },
                  user: body.user,
                }
              },
            },
            mapInput({ event }) {
              expect(event).toBe(hostEvent)
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
    }), { agentName: "support", event: hostEvent })

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
    }), { agentName: "support", event: hostEvent })

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
    }), { agentName: "support", event: hostEvent })

    expect(rejectedResponse.status).toBe(401)
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      error: "Agent chat route request was not admitted.",
    })
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.stringContaining("hello"),
    }))
  })

  it("validates the standard AI SDK chat request envelope", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      capabilities: [defineChatCapability()],
      driver: { run: () => "unused" },
    }) as never)

    const invalidBodies = [
      [[], "Agent chat payload must be a JSON object."],
      [{ text: "hello" }, "Agent chat payload requires a messages array."],
      [{ messages: [] }, "Agent chat payload requires at least one message."],
      [{ messages: [null] }, "Agent chat payload message 1 must be an object."],
      [{ messages: [{ role: "system" }] }, 'Agent chat payload message 1 role must be "user" or "assistant".'],
      [{ id: 1, messages: [{ role: "user" }] }, "id must be a string when provided."],
      [{ messageId: 1, messages: [{ role: "user" }] }, "messageId must be a string when provided."],
      [{ messages: [{ role: "user" }], trigger: 1 }, "trigger must be a string when provided."],
    ] as const

    for (const [body, error] of invalidBodies) {
      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify(body),
        method: "POST",
      }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error })
    }
  })

  it("serves explicit HTTP chat routes and preserves request extensions for admission", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const message = {
      custom: { source: "portal" },
      id: "user-1",
      metadata: { customer: "acme" },
      parts: [{ text: "hello", type: "text" }],
      role: "user",
    }
    const authenticate = vi.fn(({ body, rawBody }) => {
      expect(body).toMatchObject({ extension: { requestId: "request-1" }, messages: [message] })
      expect(rawBody).toContain('"requestId":"request-1"')
      return true
    })
    const validate = vi.fn((input: unknown) => {
      expect(input).toMatchObject({ extension: { requestId: "request-1" }, messages: [message] })
      return { value: input as { messages: unknown[] } }
    })
    const run = vi.fn(({ messages, run }) => `${run.messageId} ${run.threadId} ${JSON.stringify(messages)}`)
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: http({
          route: {
            admission: {
              authenticate,
              body: { "~standard": { validate } },
            },
          },
        }),
      },
      driver: { run },
    }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        extension: { requestId: "request-1" },
        id: "portal-thread",
        messageId: "request-message",
        messages: [message],
        trigger: "submit-message",
      }),
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("request-message portal:portal-thread")
    expect(authenticate).toHaveBeenCalledOnce()
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ id: "user-1", metadata: { customer: "acme" }, role: "user" })],
      run: expect.objectContaining({ messageId: "request-message", origin: "http", threadId: "portal:portal-thread" }),
    }))
  })

  it("rejects client-provided protected input on generated AI SDK chat routes", async () => {
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
      timeout: 120_000,
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
    const run = vi.fn(({ context, input, invoker, run }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, session?: { id?: string }, user?: { email?: string } } | undefined
      return `trusted ${run.channelId} ${run.origin} ${run.threadId} ${invoker.id} ${chatContext?.user?.email} ${chatContext?.meta?.audience} ${chatContext?.session?.id} ${input.timeout ?? "no-timeout"}`
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate },
            input: { trust: ["meta", "user", "session", "timeout"] },
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
        timeout: 120_000,
        user: { email: "user@example.com" },
      }),
      headers: {
        "content-type": "application/json",
        "x-quiver-chat-token": "trusted",
      },
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("trusted portal web-chat portal:portal-thread web-chat:user@example.com user@example.com technical portal-session 120000")
    expect(authenticate).toHaveBeenCalled()
    expect(run).toHaveBeenCalled()

    for (const body of [
      JSON.stringify({ messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }], timeout: 0 }),
      JSON.stringify({ messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }], timeout: -1 }),
      JSON.stringify({ messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }], timeout: "120000" }),
      "{\"messages\":[{\"parts\":[{\"text\":\"hello\",\"type\":\"text\"}],\"role\":\"user\"}],\"timeout\":1e400}",
    ]) {
      const invalidResponse = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body,
        headers: { "x-quiver-chat-token": "trusted" },
        method: "POST",
      }), { agentName: "support" })

      expect(invalidResponse.status).toBe(200)
      await expect(invalidResponse.text()).resolves.toContain("no-timeout")
    }
  })

  it("does not copy untrusted webChat route input after admission", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(({ context, input }) => {
      const chatContext = context.get("chat") as { meta?: { audience?: string }, session?: { id?: string }, user?: { email?: string } } | undefined
      return `trusted ${chatContext?.user?.email} ${chatContext?.meta?.audience} ${chatContext?.session?.id ?? "no-session"} ${input.timeout ?? "no-timeout"}`
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
        timeout: 120_000,
        user: { email: "user@example.com" },
      }),
      method: "POST",
    }), { agentName: "support" })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("trusted user@example.com technical no-session no-timeout")
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

  async function chatTranscriptUserKey(options: {
    identity?: () => string | null
    isBot?: boolean
    messageId: number
    transcripts?: boolean
  }): Promise<string | undefined> {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        support: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
      messages: {
        ...(options.identity ? { identity: options.identity } : {}),
        ...(options.transcripts ? { transcripts: { maxPerUser: 50, retention: "30d" as const } } : {}),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, is_bot: options.isBot, username: "maxi" },
          message_id: options.messageId,
          text: "hello",
        },
      }),
      method: "POST",
    }), "support", { agentName: "transcript-identity" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledOnce()
    const history = await adapter.fetchMessages("telegram:456")
    return history.messages[0]?.userKey
  }

  it("defaults transcript identity for human authors", async () => {
    await expect(chatTranscriptUserKey({ messageId: 7, transcripts: true })).resolves.toBe("support:123")
  })

  it("omits default transcript identity for bot authors", async () => {
    await expect(chatTranscriptUserKey({ isBot: true, messageId: 8, transcripts: true })).resolves.toBeUndefined()
  })

  it("prefers explicit transcript identity", async () => {
    await expect(chatTranscriptUserKey({
      identity: () => "account:verified",
      messageId: 9,
      transcripts: true,
    })).resolves.toBe("account:verified")
  })

  it("does not default identity when transcripts are disabled", async () => {
    await expect(chatTranscriptUserKey({ messageId: 10 })).resolves.toBeUndefined()
  })

  it("handles Chat SDK webhooks through the chat capability", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
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
    expect(invokerResolve).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        context: expect.objectContaining({
          channel: expect.objectContaining({
            message: expect.objectContaining({ id: "7", text: "hello" }),
          }),
          chat: expect.objectContaining({
            message: expect.objectContaining({ id: "7", text: "hello" }),
          }),
        }),
        messages: [expect.objectContaining({ role: "user" })],
      }),
    }))
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
            fetchMetadata: { fileId: "audio-file" },
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

  it("filters adapter messages before Agent invocation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const filter = vi.fn(async ({ message }) =>
      message.parts.length === 1 && message.parts[0]?.type === "audio")
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { filter, stream: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (message: Record<string, unknown>) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: message.message_id,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          ...message,
        },
      }),
      method: "POST",
    })

    await handler(request({ message_id: 2006, text: "hello" }), "telegram", {
      agentName: "support",
      runtime: "vite",
    })

    expect(filter).toHaveBeenCalledWith(expect.objectContaining({
      agentIdentity: { name: "support" },
      deliveryKind: "direct",
      message: expect.objectContaining({
        parts: [expect.objectContaining({ text: "hello", type: "text" })],
      }),
      request: expect.any(Request),
      run: expect.objectContaining({ messageId: "2006", origin: "telegram" }),
      runtime: "vite",
      thread: { post: expect.any(Function) },
    }))
    expect(run).not.toHaveBeenCalled()
    expect(adapter.postMessage).not.toHaveBeenCalled()

    await handler(request({
      audio: { file_id: "audio-file" },
      message_id: 2007,
    }), "telegram", {
      agentName: "support",
      runtime: "vite",
    })

    expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        parts: [expect.objectContaining({ mediaType: "audio/ogg", type: "audio" })],
      }),
    }))
    expect(run).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "accepted" })
  })

  it("classifies direct, mention, and subscribed deliveries for message filters", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const deliveryKinds: AgentMessageDeliveryKind[] = []
    const createHandler = (adapter: Adapter) => createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter,
          messages: {
            filter: ({ deliveryKind }) => {
              deliveryKinds.push(deliveryKind)
              return false
            },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const request = (messageId: number, threadId: number, isMention = false) =>
      new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: messageId,
          message: {
            chat: { id: threadId, type: "group" },
            date: 1781092800,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            isMention,
            message_id: messageId,
            text: "hello",
          },
        }),
        method: "POST",
      })

    const directHandler = createHandler(createTestChatAdapter())
    await directHandler(request(2010, 456), "telegram")

    const groupHandler = createHandler(createTestChatAdapter({ isDM: false }))
    await groupHandler(request(2011, 789, true), "telegram")
    await groupHandler(request(2012, 789), "telegram")
    await groupHandler(request(2013, 789, true), "telegram")

    expect(deliveryKinds).toEqual(["direct", "mention", "subscribed", "mention"])
  })

  it("defaults adapter-backed Channels to final-only delivery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram, webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler, createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        web: webChat,
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run: () => ({ text: "final answer" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 2043,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 2008,
          text: "hello",
        },
      }),
      method: "POST",
    }), "telegram", { waitUntil: task => waitUntilTasks.push(task) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    await Promise.all(waitUntilTasks)
    expect(agent.chat).toMatchObject({ stream: false })
    expect(adapter.startTyping).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "final answer" })
    expect(adapter.editMessage).not.toHaveBeenCalled()

    const streamResponse = await createChannelChatRouteHandler(agent as never)(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "portal-thread",
        messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(streamResponse.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    await expect(streamResponse.text()).resolves.toContain("final answer")
  })

  it("posts only the final Discord reply without a progress edit after harness tool events", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        discord: discord({ adapter: () => adapter as never }),
      },
      driver: {
        run: () => ({
          raw: {
            steps: [
              {
                content: [
                  { text: "I'll inspect the image.", type: "text" },
                  { text: "private reasoning", type: "reasoning" },
                  { input: { path: "image.png" }, toolCallId: "call-1", toolName: "view_image", type: "tool-call" },
                  { output: { ok: true }, toolCallId: "call-1", toolName: "view_image", type: "tool-result" },
                ],
              },
              {
                content: [
                  { text: "I'll verify one detail.", type: "text" },
                  { input: { query: "detail" }, toolCallId: "call-2", toolName: "search", type: "tool-call" },
                  { output: { ok: true }, toolCallId: "call-2", toolName: "search", type: "tool-result" },
                ],
              },
              {
                content: [
                  { text: "The image shows a dental X-ray.", type: "text" },
                ],
              },
            ],
          },
          text: "I'll inspect the image.I'll verify one detail.The image shows a dental X-ray.",
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2009,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord", { waitUntil: task => waitUntilTasks.push(task) })

    expect(response.status).toBe(200)
    await Promise.all(waitUntilTasks)
    expect(agent.chat).toMatchObject({ stream: false })
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "The image shows a dental X-ray." })
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("preserves traceable stream results for final-only Channel delivery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: { discord: discord({ adapter: () => adapter as never }) },
      driver: {
        run: () => ({
          text: "stale partial text",
          textStream: (async function* () { yield "Final streamed answer." })(),
        }),
      },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2015,
          text: "stream this",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Final streamed answer." })
  })

  it("posts explicitly phased commentary and final output as separate Discord replies", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn()
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "message" },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { id: "commentary-1", phase: "commentary", type: "text-start" }
            yield { delta: "Checking ", id: "commentary-1", type: "text-delta" }
            yield { delta: "private reasoning", id: "reasoning-1", type: "reasoning-delta" }
            yield { delta: "the image.", id: "commentary-1", type: "text-delta" }
            yield { id: "commentary-1", type: "text-end" }
            yield { text: "Unknown pre-final text.", type: "text-delta" }
            yield { id: "final-1", phase: "final_answer", type: "text-start" }
            yield { delta: "The image shows ", id: "final-1", type: "text-delta" }
            yield { delta: "a dental X-ray.", id: "final-1", type: "text-delta" }
            yield { id: "final-1", type: "text-end" }
          })(),
        }),
      },
      hooks: { "agent:finish": finish },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2010,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord", { waitUntil: task => waitUntilTasks.push(task) })

    expect(response.status).toBe(200)
    await Promise.all(waitUntilTasks)
    await vi.waitFor(() => {
      expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "...")
      expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", "...")
    })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "Checking the image." })
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-2", { markdown: "The image shows a dental X-ray." })
    expect(finish.mock.calls[0]![0].result).toMatchObject({ text: "The image shows a dental X-ray." })
    expect(adapter.editMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ markdown: expect.stringContaining("Unknown pre-final text") }),
    )
    expect(adapter.editMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ markdown: expect.stringContaining("private reasoning") }),
    )
  })

  it("delivers final output when the commentary reply fails", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockRejectedValueOnce(new Error("progress unavailable"))
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "message" },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { phase: "commentary", text: "Checking the image.", type: "text-delta" }
            yield { phase: "final", text: "Final answer.", type: "text-delta" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2016,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledTimes(2)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", expect.any(String), { markdown: "Final answer." })
  })

  it("does not block non-Cloudflare webhooks on stalled commentary delivery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockImplementationOnce(() => new Promise(() => undefined))
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "message" },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { phase: "commentary", text: "Checking the image.", type: "text-delta" }
            yield { phase: "final", text: "Final answer.", type: "text-delta" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(2018, 999), "discord")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledTimes(2)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:999", expect.any(String), { markdown: "Final answer." })
  })

  it("delivers unphased final output when commentary is configured", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn()
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "message" },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { phase: "upload", type: "file", url: "https://example.com/result.txt" }
            yield { text: "Final answer.", type: "text-delta" }
          })(),
        }),
      },
      hooks: { "agent:finish": finish },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2013,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", expect.any(String), { markdown: "Final answer." })
    expect(finish.mock.calls[0]![0].result).toMatchObject({ text: "Final answer." })
  })

  it("extracts JSON response text when commentary is configured", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        discord: discord({ adapter: () => adapter as never, messages: { commentary: "message" } }),
      },
      driver: { run: () => Response.json({ text: "Final answer." }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2014,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", expect.any(String), { markdown: "Final answer." })
    expect(adapter.editMessage).not.toHaveBeenCalledWith("telegram:456", expect.any(String), { markdown: JSON.stringify({ text: "Final answer." }) })
  })

  it("hides phased commentary when Channel streaming is disabled", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "hidden", stream: false },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { phase: "commentary", text: "Checking the image.", type: "text-delta" }
            yield { text: "Unknown pre-final text.", type: "text-delta" }
            yield { phase: "final", text: "Final answer.", type: "text-delta" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2012,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledTimes(1)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", expect.any(String), { markdown: "Final answer." })
  })

  it("preserves publish-all streaming when commentary is also configured", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { commentary: "message", stream: true },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { phase: "commentary", text: "Checking the image. ", type: "text-delta" }
            yield { text: "Unknown text. ", type: "text-delta" }
            yield { phase: "final", text: "Final answer.", type: "text-delta" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2017,
          text: "describe this image",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", expect.any(String), {
      markdown: "Checking the image. Unknown text. Final answer.",
    })
  })

  it("preserves bare async iterables for final-only Channel delivery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const stream = Object.assign((async function* () {
      yield { text: "Final streamed answer.", type: "text-delta" }
    })(), { text: "stale partial text" })
    const agent = defineAgent({
      channels: { discord: discord({ adapter: () => adapter as never }) },
      driver: { run: () => stream },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 2011,
          text: "stream this",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Final streamed answer." })
    })
  })

  it("scopes progressive delivery to the active Channel", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const progressiveAdapter = createTestChatAdapter()
    const finalAdapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        final: testTelegram(telegram, { adapter: () => finalAdapter as never, messages: { stream: false } }),
        progressive: testTelegram(telegram, { adapter: () => progressiveAdapter as never, messages: { stream: true } }),
      },
      driver: { run: () => ({ text: "channel reply" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (messageId: number) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: messageId,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: messageId,
          text: "hello",
        },
      }),
      method: "POST",
    })

    await handler(request(1), "progressive")
    expect(progressiveAdapter.postMessage).toHaveBeenCalledWith("telegram:456", "...")
    expect(progressiveAdapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "channel reply" })

    await handler(request(2), "final")
    expect(finalAdapter.postMessage).toHaveBeenCalledOnce()
    expect(finalAdapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "channel reply" })
    expect(finalAdapter.editMessage).not.toHaveBeenCalled()
  })

  it("splits long Discord chat output after stream finalization", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter() as ReturnType<typeof createTestChatAdapter> & {
      formatConverter: { renderPostable: (message: unknown) => string }
      name: string
    }
    adapter.formatConverter = {
      renderPostable(message: unknown) {
        if (typeof message === "string") return message
        if (typeof message === "object" && message && "raw" in message && typeof message.raw === "string") return message.raw
        if (typeof message === "object" && message && "markdown" in message && typeof message.markdown === "string") return message.markdown
        return ""
      },
    }
    adapter.name = "discord"
    Object.defineProperty(adapter, Symbol.for("vitehub.discord.longContent.mode"), { value: "split" })
    let replyText = "short reply"
    let finishReply: string | undefined
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { stream: true },
        }),
      },
      driver: {
        run: () => ({ text: replyText }),
      },
      hooks: {
        "agent:finish"(event) {
          if (!finishReply) return
          return event.reply((async function* () {
            yield finishReply
          })())
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (messageId: number) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: messageId,
          text: "hello",
        },
      }),
      method: "POST",
    })

    const shortResponse = await handler(request(7), "discord")

    expect(shortResponse.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "...")
    expect(adapter.postMessage).toHaveBeenCalledTimes(1)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "short reply" })

    adapter.postMessage.mockClear()
    adapter.editMessage.mockClear()
    replyText = `${"word ".repeat(430)}done`
    finishReply = `${"side ".repeat(430)}done`

    const longResponse = await handler(request(8), "discord")

    expect(longResponse.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "...")
    expect(adapter.editMessage).toHaveBeenNthCalledWith(1, "telegram:456", "sent-2", { markdown: replyText })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(2, "telegram:456", "sent-2", {
      attachments: [],
      raw: expect.stringMatching(/ \(1\/2\)$/),
    })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", {
      raw: expect.stringMatching(/ \(2\/2\)$/),
    })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(3, "telegram:456", "sent-4", { markdown: finishReply })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(4, "telegram:456", "sent-4", {
      attachments: [],
      raw: expect.stringMatching(/ \(1\/2\)$/),
    })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(4, "telegram:456", {
      raw: expect.stringMatching(/ \(2\/2\)$/),
    })
  })

  it("splits long non-streaming Discord chat output", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter() as ReturnType<typeof createTestChatAdapter> & {
      formatConverter: { renderPostable: (message: unknown) => string }
      name: string
    }
    adapter.formatConverter = {
      renderPostable(message: unknown) {
        if (typeof message === "string") return message
        if (typeof message === "object" && message && "raw" in message && typeof message.raw === "string") return message.raw
        if (typeof message === "object" && message && "markdown" in message && typeof message.markdown === "string") return message.markdown
        return ""
      },
    }
    adapter.name = "discord"
    Object.defineProperty(adapter, Symbol.for("vitehub.discord.longContent.mode"), { value: "split" })
    const replyText = `${"word ".repeat(430)}done`
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: { stream: false },
        }),
      },
      driver: {
        run: () => ({ text: replyText }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { id: 123, username: "maxi" },
          message_id: 9,
          text: "hello",
        },
      }),
      method: "POST",
    }), "discord")

    expect(response.status).toBe(200)
    expect(adapter.editMessage).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", {
      raw: expect.stringMatching(/ \(1\/2\)$/),
    })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", {
      raw: expect.stringMatching(/ \(2\/2\)$/),
    })
    expect(adapter.postMessage).toHaveBeenCalledTimes(2)
  })

  it("maps audio mime file attachments by default without resolving bytes", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const attachmentFetchData = vi.fn(async () => Buffer.from([1, 2, 3]))
    const adapter = createTestChatAdapter({ attachmentFetchData })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            file_id: "forwarded-audio-file",
            file_name: "forwarded.ogg",
            file_size: 3,
            mime_type: "audio/ogg",
            url: "https://cdn.example.com/forwarded.ogg",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 108,
          text: "reenviado",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: [
          expect.objectContaining({ text: "reenviado", type: "text" }),
          expect.objectContaining({
            fetchData: expect.any(Function),
            fetchMetadata: { fileId: "forwarded-audio-file" },
            mediaType: "audio/ogg",
            name: "forwarded.ogg",
            size: 3,
            type: "audio",
            url: "https://cdn.example.com/forwarded.ogg",
          }),
        ],
      })],
    }))
    expect(attachmentFetchData).not.toHaveBeenCalled()
  })

  it("invokes chat agents for attachment-only image messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const attachmentFetchData = vi.fn(async () => Buffer.from([1, 2, 3]))
    const adapter = createTestChatAdapter({ attachmentFetchData })
    const hostIdentity = { name: "support", workspace: "support-workspace" }
    const run = vi.fn(({ agentIdentity }) => {
      expect(agentIdentity).toEqual(hostIdentity)
      return "ok"
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1009,
          photo: [
            { file_id: "small-photo", file_size: 1, height: 90, width: 90 },
            { file_id: "large-photo", file_size: 3, height: 1280, width: 960 },
          ],
        },
      }),
      method: "POST",
    }), "telegram", { agentIdentity: hostIdentity })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: [
          expect.objectContaining({
            fetchData: expect.any(Function),
            fetchMetadata: { fileId: "large-photo" },
            mediaType: "image/jpeg",
            size: 3,
            type: "image",
          }),
        ],
      })],
    }))
    expect(attachmentFetchData).not.toHaveBeenCalled()
  })

  it("derives missing image MIME types from attachment metadata", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ photoData: new Blob(["image"], { type: "application/octet-stream" }) })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: { telegram: testTelegram(telegram, { adapter: () => adapter as never }) },
      driver: { run },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 44,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1014,
          photo: [{ file_id: "image", file_name: "screenshot.png", url: "https://example.com/screenshot.png" }],
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: [expect.objectContaining({
          mediaType: "image/png",
          type: "image",
        })],
      })],
    }))
  })

  it("preflights a deployed Channel webhook without invoking or verifying it", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => createTestChatAdapter() as never,
          webhookSecret: "secret-token",
        }),
      },
      driver: { run },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request(
      "https://example.com/api/_vitehub/agents/support/webhooks/telegram",
      { method: "HEAD" },
    ), "telegram")

    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-vitehub-channel-provider")).toBe("telegram")
    expect(run).not.toHaveBeenCalled()
  })

  it("preserves generic attachment URLs as typed references", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: { telegram: testTelegram(telegram, { adapter: () => adapter as never }) },
      driver: { run },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 43,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            file_name: "report.pdf",
            file_size: 2048,
            mime_type: "application/pdf",
            url: "https://cdn.discordapp.com/attachments/channel/message/report.pdf",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1013,
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: [expect.objectContaining({
          mediaType: "application/pdf",
          name: "report.pdf",
          size: 2048,
          type: "file",
          url: "https://cdn.discordapp.com/attachments/channel/message/report.pdf",
        })],
      })],
    }))
  })

  it("maps text-like file attachments to text parts", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(({ messages }) => messages.at(-1)?.parts
      .filter((part: { type?: string }) => part.type === "text")
      .map((part: { text?: string }) => part.text)
      .join(""))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            content: "# Notes\n- first\n",
            file_id: "notes-file",
            file_name: "notes.md",
            file_size: 16,
            mime_type: "text/markdown; charset=utf-8",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1010,
          text: "see attached",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: [
          expect.objectContaining({ text: "see attached", type: "text" }),
          expect.objectContaining({
            text: "\n\nText attachment (notes.md):\n\n# Notes\n- first",
            type: "text",
          }),
        ],
      })],
    }))

    const attachmentBody = "x".repeat(1024 * 1024 + 1)
    const attachmentPrefix = "\n\nText attachment (large-prompt.txt):\n\n"
    run.mockClear()
    const largeResponse = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            content: attachmentBody,
            file_id: "large-prompt-file",
            file_name: "large-prompt.txt",
            file_size: attachmentBody.length,
            mime_type: "text/plain",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 1012,
        },
      }),
      method: "POST",
    }), "telegram")
    const largePrompt = run.mock.results.at(-1)?.value as string | undefined

    expect(largeResponse.status).toBe(200)
    await expect(largeResponse.json()).resolves.toEqual({ ok: true })
    expect(largePrompt?.startsWith(attachmentPrefix)).toBe(true)
    expect(largePrompt).toHaveLength(attachmentPrefix.length + attachmentBody.length)
  })

  it("maps audio mime file attachments for custom audio capabilities", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let inputMessages: unknown
    const input = vi.fn((context: { input: { messages: () => unknown } }) => {
      inputMessages = context.input.messages()
    })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "custom-audio",
          input,
        }),
      ],
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            file_id: "forwarded-audio-file",
            file_name: "forwarded.ogg",
            file_size: 3,
            mime_type: "audio/ogg",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 110,
          text: "reenviado",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(input).toHaveBeenCalledOnce()
    expect(inputMessages).toEqual([expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ text: "reenviado", type: "text" }),
        expect.objectContaining({
          fetchData: expect.any(Function),
          fetchMetadata: { fileId: "forwarded-audio-file" },
          mediaType: "audio/ogg",
          name: "forwarded.ogg",
          type: "audio",
        }),
      ]),
    })])
  })

  it("maps audio mime file attachments for nested custom audio capabilities", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let inputMessages: unknown
    const input = vi.fn((context: { input: { messages: () => unknown } }) => {
      inputMessages = context.input.messages()
    })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          capabilities: [
            defineCapability({
              id: "nested-audio",
              input,
            }),
          ],
          id: "audio-bundle",
        }),
      ],
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            file_id: "forwarded-audio-file",
            file_name: "forwarded.ogg",
            file_size: 3,
            mime_type: "audio/ogg",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 111,
          text: "reenviado",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(input).toHaveBeenCalledOnce()
    expect(inputMessages).toEqual([expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ text: "reenviado", type: "text" }),
        expect.objectContaining({
          fetchData: expect.any(Function),
          fetchMetadata: { fileId: "forwarded-audio-file" },
          mediaType: "audio/ogg",
          name: "forwarded.ogg",
          type: "audio",
        }),
      ]),
    })])
  })

  it("maps audio mime file attachments through transcribe()", async () => {
    const { transcribe } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const execute = vi.fn(async () => "audio transcript")
    const run = vi.fn(({ messages }) => {
      const text = messages.at(-1)?.parts
        .filter((part: { type?: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text)
        .join("")
      return `ok: ${text}`
    })
    const agent = defineAgent({
      capabilities: [
        transcribe({ execute }),
      ],
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: 42,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800,
          document: {
            file_id: "forwarded-audio-file",
            file_name: "forwarded.ogg",
            file_size: 3,
            mime_type: "audio/ogg",
          },
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 109,
          text: "reenviado",
        },
      }),
      method: "POST",
    }), "telegram")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(execute).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        fetchData: expect.any(Function),
        fetchMetadata: { fileId: "forwarded-audio-file" },
        mediaType: "audio/ogg",
        name: "forwarded.ogg",
        type: "audio",
      }),
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({ text: "reenviado", type: "text" }),
          expect.objectContaining({ text: "\naudio transcript", type: "text" }),
        ]),
      })],
    }))
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "ok: reenviado\naudio transcript" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
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
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "echo: hello" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("forwards Discord Gateway events to the registered webhook id", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createDiscordGatewayRouteHandler } = await import("../src/server.ts")
    const startGatewayListener = vi.fn(async () => Response.json({ ok: true }))
    const adapter = {
      ...createTestChatAdapter(),
      name: "discord",
      startGatewayListener,
    }
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          webhooks: { id: "discord-events" },
        }),
      },
      driver: {
        run: vi.fn(),
      },
    })
    const handler = createDiscordGatewayRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway"), {
      webhookUrl: webhook => `https://example.com/api/_vitehub/agents/support/webhooks/${webhook}`,
    })

    expect(response.status).toBe(200)
    expect(startGatewayListener).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: expect.any(Function) }),
      undefined,
      undefined,
      "https://example.com/api/_vitehub/agents/support/webhooks/discord-events",
    )
  })

  it("rejects non-GET Discord Gateway requests", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createDiscordGatewayRouteHandler } = await import("../src/server.ts")
    const adapter = {
      ...createTestChatAdapter(),
      name: "discord",
      startGatewayListener: vi.fn(async () => Response.json({ ok: true })),
    }
    const agent = defineAgent({
      channels: {
        discord: discord({ adapter: () => adapter as never }),
      },
      driver: {
        run: vi.fn(),
      },
    })
    const handler = createDiscordGatewayRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway", {
      method: "POST",
    }), { webhookUrl: "https://example.com/api/_vitehub/agents/support/webhooks/discord" })

    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toMatchObject({
      message: "Discord Gateway route only accepts GET requests.",
    })
    expect(adapter.startGatewayListener).not.toHaveBeenCalled()
  })

  it("maps Discord Gateway URL-only text file attachments and rejects oversized text-like content", async () => {
    const { access } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createDiscordGatewayRouteHandler } = await import("../src/server.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("expanded Discord prompt\n", {
      headers: { "content-length": "24", "content-type": "text/plain" },
    }))
    let document: { file_name: string, file_size?: number, mime_type: string, url: string } = {
      file_name: "message.txt",
      file_size: 24,
      mime_type: "text/plain",
      url: "https://cdn.example/message.txt",
    }
    let messageId = "msg-1"
    const adapter = {
      ...createTestChatAdapter(),
      name: "discord",
      startGatewayListener: vi.fn(async (_options, _durationMs, _abortSignal, webhookUrl) => {
        if (!webhookUrl) return Response.json({ ok: false }, { status: 500 })
        return await webhookHandler(new Request(webhookUrl, {
          body: JSON.stringify({
            message: {
              chat: { id: "support" },
              document,
              from: { id: "42", username: "maxi" },
              message_id: messageId,
            },
          }),
          method: "POST",
        }), "discord-events")
      }),
    }
    const admitChat = vi.fn(() => true)
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [access({ chat: { resolve: admitChat } })],
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          webhooks: { id: "discord-events" },
        }),
      },
      driver: {
        run,
      },
    })
    const webhookHandler = createChannelWebhookRouteHandler(agent as never)
    const gatewayHandler = createDiscordGatewayRouteHandler(agent as never)

    try {
      const response = await gatewayHandler(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway"), {
        webhookUrl: webhook => `https://example.com/api/_vitehub/agents/support/webhooks/${webhook}`,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(adapter.startGatewayListener).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith("https://cdn.example/message.txt")
      expect(run).toHaveBeenCalledWith(expect.objectContaining({
        messages: [expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: "\n\nText attachment (message.txt):\n\nexpanded Discord prompt",
              type: "text",
            }),
          ],
        })],
      }))

      document = {
        file_name: "denied.txt",
        mime_type: "text/plain",
        url: "https://cdn.example/denied.txt",
      }
      messageId = "msg-denied"
      admitChat.mockClear()
      admitChat.mockReturnValueOnce(false)
      fetch.mockClear()
      run.mockClear()

      const deniedResponse = await webhookHandler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord-events", {
        body: JSON.stringify({
          message: {
            chat: { id: "support" },
            document,
            from: { id: "42", username: "maxi" },
            message_id: messageId,
          },
        }),
        method: "POST",
      }), "discord-events")
      expect(deniedResponse.status).toBe(200)
      expect(admitChat).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()

      fetch.mockResolvedValueOnce(new Response("too large", {
        headers: { "content-length": String(8 * 1024 * 1024 + 1), "content-type": "text/plain" },
      }))
      document = {
        file_name: "large.log",
        mime_type: "text/plain",
        url: "https://cdn.example/large.log",
      }
      messageId = "msg-oversized"
      admitChat.mockClear()
      run.mockClear()

      await expect(gatewayHandler(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway"), {
        webhookUrl: webhook => `https://example.com/api/_vitehub/agents/support/webhooks/${webhook}`,
      })).rejects.toThrow("[vitehub] Chat text attachment exceeds 8388608 bytes.")
      expect(fetch).toHaveBeenCalledWith("https://cdn.example/large.log")
      expect(admitChat).toHaveBeenCalledOnce()
      expect(run).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })

  it("starts Discord Gateway listeners for every Discord channel", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createDiscordGatewayRouteHandler } = await import("../src/server.ts")
    let resolveSupportGateway!: (response: Response) => void
    let markSupportGatewayStarted!: () => void
    const supportGatewayStarted = new Promise<void>(resolve => {
      markSupportGatewayStarted = resolve
    })
    const supportStartGatewayListener = vi.fn(() => {
      markSupportGatewayStarted()
      return new Promise<Response>((resolveResponse) => {
        resolveSupportGateway = resolveResponse
      })
    })
    const alertsStartGatewayListener = vi.fn(async () => Response.json({ ok: true }))
    const supportAdapter = {
      ...createTestChatAdapter(),
      name: "discord",
      startGatewayListener: supportStartGatewayListener,
    }
    const alertsAdapter = {
      ...createTestChatAdapter(),
      name: "discord",
      startGatewayListener: alertsStartGatewayListener,
    }
    const agent = defineAgent({
      channels: {
        alerts: discord({
          adapter: () => alertsAdapter as never,
          webhooks: { id: "alerts-events" },
        }),
        support: discord({
          adapter: () => supportAdapter as never,
          webhooks: { id: "support-events" },
        }),
      },
      driver: {
        run: vi.fn(),
      },
    })
    const handler = createDiscordGatewayRouteHandler(agent as never)

    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway"), {
      webhookUrl: webhook => `https://example.com/api/_vitehub/agents/support/webhooks/${webhook}`,
    })

    await supportGatewayStarted
    expect(alertsStartGatewayListener).toHaveBeenCalledOnce()
    resolveSupportGateway(Response.json({ ok: true }))
    const response = await responsePromise

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ gateways: 2, ok: true })
    expect(supportStartGatewayListener).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: expect.any(Function) }),
      undefined,
      undefined,
      "https://example.com/api/_vitehub/agents/support/webhooks/support-events",
    )
    expect(alertsStartGatewayListener).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: expect.any(Function) }),
      undefined,
      undefined,
      "https://example.com/api/_vitehub/agents/support/webhooks/alerts-events",
    )
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
        telegram: testTelegram(telegram, {
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

  it("initializes polling Telegram Channels through the host-independent polling route", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createTelegramPollingRouteHandler } = await import("../src/server.ts")
    const adapter = createTestChatAdapter()
    const triggerOnlyAdapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          mode: "polling",
        }),
        triggerOnly: testTelegram(telegram, {
          adapter: () => triggerOnlyAdapter as never,
          messages: false,
          mode: "polling",
        }),
      },
      driver: {
        run: vi.fn(),
      },
    })
    const handler = createTelegramPollingRouteHandler(agent as never)

    const first = await handler(new Request("https://example.com/api/_vitehub/agents/support/telegram/polling"))
    const second = await handler(new Request("https://example.com/api/_vitehub/agents/support/telegram/polling"))

    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ ok: true, polling: 1 })
    expect(second.status).toBe(200)
    expect(adapter.initialize).toHaveBeenCalledOnce()
    expect(triggerOnlyAdapter.initialize).not.toHaveBeenCalled()
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
    const waitUntilTasks: Promise<unknown>[] = []
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

    const response = await handler(request(githubSignature("secret-token", body)), undefined, {
      waitUntil: task => waitUntilTasks.push(task),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true, ok: true })
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
    await Promise.all(waitUntilTasks)
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
    const waitUntilTasks: Promise<unknown>[] = []
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
    }), "", { waitUntil: task => waitUntilTasks.push(task) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true, ok: true })
    await Promise.all(waitUntilTasks)
    expect(run).toHaveBeenCalledOnce()
  })

  it("acks slow GitHub channel webhooks before the background run completes", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    let releaseRun!: () => void
    let completed = false
    const runFinished = new Promise<void>(resolve => {
      releaseRun = resolve
    })
    const run = vi.fn(async () => {
      await runFinished
      completed = true
      return "accepted"
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({ input: { prompt: "github delivery" } }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: {
        run
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []
    const responsePromise = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/github", {
      body: JSON.stringify({ action: "opened" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-slow",
        "x-github-event": "pull_request",
      },
      method: "POST",
    }), "github", { waitUntil: task => waitUntilTasks.push(task) })
    const response = await Promise.race([
      responsePromise,
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 25)),
    ])

    if (response === "blocked") {
      releaseRun()
      await responsePromise
      throw new Error("GitHub webhook response waited for background run completion.")
    }
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true, ok: true })
    expect(completed).toBe(false)

    releaseRun()
    await Promise.all(waitUntilTasks)
    expect(completed).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it("flushes waitUntil for non-workflow webhook results shaped like queued provider responses", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    let flushed = false
    const run = vi.fn((context) => {
      context.waitUntil(Promise.resolve().then(() => {
        flushed = true
      }))
      return { provider: "github", status: "queued" }
    })
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
    const waitUntilTasks: Promise<unknown>[] = []
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
    }), "", { waitUntil: task => waitUntilTasks.push(task) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true, ok: true })
    await Promise.all(waitUntilTasks)
    expect(flushed).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it("runs GitHub channel webhooks through workflow-backed agents", async () => {
    const { defineAgent, workflow } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { getWorkflowRun } = await import("@vite-hub/workflow")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    let releaseRun!: () => void
    const runFinished = new Promise<void>(resolve => {
      releaseRun = resolve
    })
    const run = vi.fn(async (context) => {
      await runFinished
      return `accepted ${context.prompt}`
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({
                input: { prompt: "github delivery" },
                run: { channelId: "github", origin: "github", runId: "github:delivery-workflow" },
              }),
            },
          },
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: {
        run
      },
      runtime: workflow("support-agent"),
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []
    const body = JSON.stringify({ action: "opened" })
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const responsePromise = handler(new Request("https://example.com/api/github/webhook", {
        body,
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-workflow",
          "x-github-event": "pull_request",
          "x-hub-signature-256": githubSignature("secret-token", body),
        },
        method: "POST",
      }), "", { waitUntil: task => waitUntilTasks.push(task) })
      const response = await Promise.race([
        responsePromise,
        new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 25)),
      ])

      if (response === "blocked") {
        releaseRun()
        await responsePromise
      }
      expect(response).not.toBe("blocked")
      if (response === "blocked") throw new Error("Workflow webhook response waited for deferred workflow completion.")
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json).toEqual({ accepted: true, ok: true })
      await Promise.all(waitUntilTasks)
      releaseRun()
      await vi.waitFor(async () => {
        await expect(getWorkflowRun("support-agent", "github:delivery-workflow")).resolves.toMatchObject({
          result: "accepted github delivery",
          status: "completed",
        })
      })
      expect(run).toHaveBeenCalledOnce()
    }
    finally {
      resetWorkflowRuntime()
    }
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

  it("persists every webhook delivery and drains it under global concurrency", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-queue-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
    const releases: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active -= 1
      return "accepted"
    })
    const invoke = vi.fn((_context, input) => {
      const deliveryId = (input as { github?: { deliveryId?: string } }).github?.deliveryId || ""
      const number = (input as { payload?: { number?: number } }).payload?.number || 0
      return {
        delivery: { finishEffects: () => undefined },
        input: { prompt: deliveryId },
        webhook: {
          concurrencyGroup: "reviews:priority",
          concurrencyKey: `pr:${number}`,
          concurrencyLimit: 2,
          deliveryId,
        },
      }
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke,
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (deliveryId: string, number: number) => new Request("https://example.com/api/github/webhook", {
      body: JSON.stringify({ number }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
      },
      method: "POST",
    })
    const options = { agentName: "review", webhookState: state }

    try {
      const responses = await Promise.all([
        handler(request("delivery-1", 1), "github", options),
        handler(request("delivery-2", 2), "github", options),
        handler(request("delivery-3", 3), "github", options),
        handler(request("delivery-4", 4), "github", options),
      ])
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200])
      expect(enqueue).toHaveBeenCalledTimes(4)
      expect(enqueue.mock.calls.every(([delivery]) => delivery.invocation === undefined)).toBe(true)
      expect(enqueue.mock.calls.map(([delivery]) => delivery.concurrencyKey)).toEqual([
        "review:reviews%3Apriority:pr%3A1",
        "review:reviews%3Apriority:pr%3A2",
        "review:reviews%3Apriority:pr%3A3",
        "review:reviews%3Apriority:pr%3A4",
      ])
      await expect(Promise.all(responses.map(response => response.json()))).resolves.toEqual([
        { accepted: true, duplicate: false, ok: true, queued: true },
        { accepted: true, duplicate: false, ok: true, queued: true },
        { accepted: true, duplicate: false, ok: true, queued: true },
        { accepted: true, duplicate: false, ok: true, queued: true },
      ])
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(maxActive).toBe(2)

      const duplicate = await handler(request("delivery-4", 4), "github", options)
      await expect(duplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, queued: false })

      releases.splice(0).forEach(release => release())
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
      expect(maxActive).toBe(2)
      releases.splice(0).forEach(release => release())
      await vi.waitFor(() => expect(active).toBe(0))
      expect(invoke).toHaveBeenCalledTimes(9)
    }
    finally {
      releases.splice(0).forEach(release => release())
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("replaces request abort signals before persisting webhook invocations", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-abort-signal-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
    const run = vi.fn(({ input }: { input: { abortSignal?: AbortSignal } }) => {
      expect(input.abortSignal).toBeInstanceOf(AbortSignal)
      expect(input.abortSignal?.aborted).toBe(false)
      return "accepted"
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: {
                  abortSignal: AbortSignal.abort(new Error("request ended")),
                  prompt: "persist safely",
                },
                webhook: {
                  concurrencyLimit: 1,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = await handler(new Request("https://example.com/api/github/webhook", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-abort-signal",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", { agentName: "review", webhookState: state })

      expect(response.status).toBe(200)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(enqueue.mock.calls[0]?.[0].invocation?.input).not.toHaveProperty("abortSignal")
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("re-resolves webhook invocations that cannot round-trip through JSON", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-json-safety-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
    const run = vi.fn(() => "accepted")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const invoke = vi.fn((_context, input) => ({
      input: { context: cyclic, options: { sequence: 1n }, prompt: "resolve again" },
      webhook: {
        concurrencyLimit: 1,
        deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
      },
    }))
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: { webhook: { invoke } },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = await handler(new Request("https://example.com/api/github/webhook", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-json-safety",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", { agentName: "review", webhookState: state })

      expect(response.status).toBe(200)
      expect(enqueue.mock.calls[0]?.[0].invocation).toBeUndefined()
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(invoke).toHaveBeenCalledTimes(2)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("rehydrates queued webhook invocations before running the agent", async () => {
    const { getActiveCloudflareEnv } = await import("@vite-hub/internal/runtime/cloudflare-env")
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-rehydrate-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
    const rehydrationWork = vi.fn()
    let triggerContext!: { waitUntil: (task: Promise<unknown>) => void }
    const run = vi.fn(() => {
      expect(rehydrationWork).toHaveBeenCalledOnce()
      return "accepted"
    })
    const rehydrate = vi.fn(() => {
      expect(getActiveCloudflareEnv()?.SOURCE_TOKEN).toBe("fresh-token")
      triggerContext.waitUntil(Promise.resolve().then(rehydrationWork))
      return {
        input: { prompt: "fresh source data" },
        webhook: { concurrencyLimit: 1, deliveryId: "delivery-rehydrate" },
      }
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (context) => {
                triggerContext = context
                return {
                  input: { prompt: "stale source data" },
                  webhook: { concurrencyLimit: 1, deliveryId: "delivery-rehydrate", rehydrate },
                }
              },
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })

    try {
      const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/github/webhook", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-rehydrate",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", {
        agentName: "review",
        cloudflare: { env: { SOURCE_TOKEN: "fresh-token" } },
        webhookState: state,
      })

      expect(response.status).toBe(200)
      expect(enqueue.mock.calls[0]?.[0].invocation).toBeUndefined()
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(rehydrate).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({ prompt: "fresh source data" }),
      }))
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("steers an active queued webhook invocation once and queues when control rejects or closes", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { agentInvocationControlId, registerAgentInvocationInputHandler } = await import("../src/internal/agent-invocation-control.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-steer-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const releases: Array<() => void> = []
    const closeControls: Array<() => void> = []
    const steeredInputs: unknown[] = []
    let releaseSteer: () => void = () => undefined
    const steerAccepted = new Promise<void>(resolve => { releaseSteer = resolve })
    let rejectSteer = false
    let failFlush = false
    let completedRuns = 0
    const run = vi.fn(async (context: { run?: { runId?: string }, waitUntil: (task: Promise<unknown>) => void }) => {
      const { run: metadata } = context
      const controlId = agentInvocationControlId(context)
      if (!metadata?.runId || !controlId) throw new Error("Expected controlled Agent Invocation identities.")
      const closeControl = registerAgentInvocationInputHandler(controlId, {
        async sendInput(input, options) {
          expect(options).toEqual({ mode: "steer" })
          if (rejectSteer) throw new Error("closed")
          steeredInputs.push(input)
          await steerAccepted
          return "accepted" as const
        },
        support: { steer: true },
      })
      closeControls.push(closeControl)
      try {
        await new Promise<void>(resolve => releases.push(resolve))
        if (failFlush) context.waitUntil(Promise.reject(new Error("flush failed")))
        return "accepted"
      }
      finally {
        closeControl()
        completedRuns += 1
      }
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                const deliveryId = (input as { github: { deliveryId: string } }).github.deliveryId
                return {
                  input: { prompt: deliveryId },
                  run: { runId: deliveryId },
                  webhook: {
                    busy: "steer",
                    concurrencyGroup: "reviews",
                    concurrencyKey: "pr-42",
                    concurrencyLimit: 1,
                    concurrencyTtlMs: 1_000,
                    deliveryId,
                  },
                }
              },
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (deliveryId: string) => new Request("https://example.com/api/github/webhook", {
      body: JSON.stringify({ number: 42 }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
      },
      method: "POST",
    })
    const waitUntilTasks: Promise<unknown>[] = []
    const options = {
      agentName: "review",
      waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task),
      webhookState: state,
    }
    let stop: () => void | Promise<void> = () => undefined
    vi.useFakeTimers()

    try {
      stop = handler.resume(options)
      const first = await handler(request("delivery-1"), "github", options)
      await expect(first.json()).resolves.toEqual({ accepted: true, duplicate: false, ok: true, queued: true })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ run: expect.objectContaining({ runId: "delivery-1" }) }))

      const waitUntilCount = waitUntilTasks.length
      const steering = handler(request("delivery-2"), "github", options)
      await vi.waitFor(() => expect(steeredInputs).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(1_100)
      const concurrentDelivery = await handler(request("delivery-6"), "github", options)
      expect(concurrentDelivery.status).toBe(503)
      await expect(concurrentDelivery.json()).resolves.toEqual({ accepted: false, busy: true, ok: true })
      expect(steeredInputs).toHaveLength(1)
      const inFlightDuplicate = await handler(request("delivery-2"), "github", options)
      await expect(inFlightDuplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, steered: true })
      expect(steeredInputs).toHaveLength(1)

      releaseSteer()
      const steered = await steering
      await expect(steered.json()).resolves.toEqual({ accepted: true, ok: true, steered: true })
      expect(waitUntilTasks.length).toBeGreaterThan(waitUntilCount)
      expect(waitUntilTasks.at(-1)).toBeInstanceOf(Promise)
      expect(steeredInputs).toEqual([expect.objectContaining({ prompt: "delivery-2" })])

      const duplicate = await handler(request("delivery-2"), "github", options)
      await expect(duplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, steered: true })
      expect(steeredInputs).toHaveLength(1)

      rejectSteer = true
      const rejected = await handler(request("delivery-3"), "github", options)
      await expect(rejected.json()).resolves.toEqual({ accepted: true, duplicate: false, ok: true, queued: true })
      rejectSteer = false
      const rejectedReplay = await handler(request("delivery-3"), "github", options)
      await expect(rejectedReplay.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, queued: false })
      expect(steeredInputs).toHaveLength(1)

      expect(run).toHaveBeenCalledOnce()
      expect(closeControls).toHaveLength(1)
      closeControls[0]!()
      const queued = await handler(request("delivery-4"), "github", options)
      await expect(queued.json()).resolves.toEqual({ accepted: true, duplicate: false, ok: true, queued: true })
      expect(steeredInputs).toHaveLength(1)
      expect(run).toHaveBeenCalledOnce()

      stop()
      failFlush = true
      releases.shift()!()
      await vi.waitFor(() => expect(completedRuns).toBe(1))
      failFlush = false
      await vi.waitFor(async () => expect(await state.get("webhook:review:github:github:steer:delivery-2")).toBeNull())
      const absent = await handler(request("delivery-2"), "github", options)
      await expect(absent.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, queued: false })
      expect(steeredInputs).toHaveLength(1)
      expect(run).toHaveBeenCalledOnce()
      stop = handler.resume(options)

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 3_000 })
      releases.shift()!()
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
      releases.shift()!()
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
      releases.shift()!()
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5))
      releases.shift()!()
      await vi.waitFor(() => expect(completedRuns).toBe(5))
    }
    finally {
      const stopping = stop()
      releaseSteer()
      releases.splice(0).forEach(release => release())
      await stopping
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  }, 15_000)

  it("scopes active webhook steering to the resolved state backend", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { agentInvocationControlId, registerAgentInvocationInputHandler } = await import("../src/internal/agent-invocation-control.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-steer-backend-"))
    const stateUrls = {
      first: `file:${join(stateDir, "first.sqlite")}`,
      second: `file:${join(stateDir, "second.sqlite")}`,
    }
    const states: Array<ReturnType<typeof createLibsqlAgentState>> = []
    const releases: Array<() => void> = []
    const steeredInputs: string[] = []
    const run = vi.fn(async (context: { run?: { runId?: string } }) => {
      const controlId = agentInvocationControlId(context)
      if (!controlId) throw new Error("Expected an Agent Invocation control identity.")
      const unregister = registerAgentInvocationInputHandler(controlId, {
        sendInput(input) {
          steeredInputs.push(String(input.prompt))
          return "accepted"
        },
        support: { steer: true },
      })
      try {
        await new Promise<void>(resolve => releases.push(resolve))
        return "accepted"
      }
      finally {
        unregister()
      }
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                const deliveryId = (input as { github: { deliveryId: string } }).github.deliveryId
                return {
                  input: { prompt: deliveryId },
                  run: { runId: deliveryId },
                  webhook: {
                    busy: "steer",
                    concurrencyKey: "shared",
                    concurrencyLimit: 1,
                    deliveryId,
                  },
                }
              },
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (deliveryId: string, tenant: keyof typeof stateUrls) => new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-tenant": tenant,
      },
      method: "POST",
    })
    const options = {
      agentName: "review",
      webhookState: (context: { request?: Request }) => {
        const tenant = context.request?.headers.get("x-tenant") as keyof typeof stateUrls
        const state = createLibsqlAgentState({ url: stateUrls[tenant] })
        states.push(state)
        return state
      },
    }

    try {
      await handler(request("first-run", "first"), "github", options)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await expect(states[0]?.get("webhook:backend-id")).resolves.toEqual(expect.any(String))

      const sameBackend = await handler(request("same-backend-steer", "first"), "github", options)
      await expect(sameBackend.json()).resolves.toEqual({ accepted: true, ok: true, steered: true })
      expect(steeredInputs).toEqual(["same-backend-steer"])

      const otherBackend = await handler(request("other-backend-run", "second"), "github", options)
      await expect(otherBackend.json()).resolves.toEqual({ accepted: true, duplicate: false, ok: true, queued: true })
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(steeredInputs).toEqual(["same-backend-steer"])
    }
    finally {
      releases.splice(0).forEach(release => release())
      await vi.waitFor(() => expect(releases).toHaveLength(0)).catch(() => undefined)
      await Promise.all(states.map(state => state.disconnect().catch(() => undefined)))
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("resumes persisted webhook deliveries after a process restart", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-resume-"))
    const url = `file:${join(stateDir, "state.sqlite")}`
    const scope = "webhook:review:github:github:"
    const body = JSON.stringify({ number: 42 })
    const firstProcessState = createLibsqlAgentState({ url })
    await firstProcessState.connect()
    await firstProcessState.enqueueWebhookDelivery({
      concurrencyGroup: "review:reviews",
      concurrencyKey: "review:reviews:pr-42",
      concurrencyLimit: 2,
      deliveryId: "delivery-restart",
      enqueuedAt: Date.now(),
      leaseTtlMs: 1_000,
      request: {
        body,
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-restart",
          "x-github-event": "pull_request",
        },
        method: "POST",
        url: "https://example.com/api/github/webhook",
      },
      scope,
      webhookId: "github",
    })
    await firstProcessState.disconnect()

    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "resumed" },
                webhook: {
                  concurrencyGroup: "reviews",
                  concurrencyKey: `pr-${(input as { payload: { number: number } }).payload.number}`,
                  concurrencyLimit: 2,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const restoredState = createLibsqlAgentState({ url })
    const stop = createChannelWebhookRouteHandler(agent as never).resume({
      agentName: "review",
      webhookState: restoredState,
    })

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await vi.waitFor(async () => {
        await expect(restoredState.enqueueWebhookDelivery({
          concurrencyGroup: "review:reviews",
          concurrencyLimit: 2,
          deliveryId: "delivery-restart",
          enqueuedAt: Date.now(),
          leaseTtlMs: 1_000,
          request: { body, headers: {}, method: "POST", url: "https://example.com" },
          scope,
          webhookId: "github",
        })).resolves.toBe(false)
      })
    }
    finally {
      stop()
      await restoredState.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("retries webhook queue discovery after a transient startup failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-discovery-retry-"))
    const url = `file:${join(stateDir, "state.sqlite")}`
    const scope = "webhook:review:github:github:"
    const state = createLibsqlAgentState({ url })
    const body = JSON.stringify({ number: 42 })
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "resumed" },
                webhook: {
                  concurrencyLimit: 1,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    let stop: () => void | Promise<void> = () => undefined

    try {
      vi.useFakeTimers()
      await state.connect()
      await state.enqueueWebhookDelivery({
        concurrencyGroup: "review:default",
        concurrencyLimit: 1,
        deliveryId: "delivery-discovery-retry",
        enqueuedAt: Date.now(),
        leaseTtlMs: 1_000,
        request: {
          body,
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "delivery-discovery-retry",
            "x-github-event": "pull_request",
          },
          method: "POST",
          url: "https://example.com/api/github/webhook",
        },
        scope,
        webhookId: "github",
      })
      const resolveState = vi.fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValue(state)
      stop = createChannelWebhookRouteHandler(agent as never).resume({
        agentName: "review",
        webhookState: resolveState,
      })
      await vi.waitFor(() => expect(resolveState).toHaveBeenCalledOnce())
      expect(run).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(resolveState).toHaveBeenCalledTimes(2)
    }
    finally {
      stop()
      consoleError.mockRestore()
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("stops queue claims and heartbeat ownership during shutdown", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-stop-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    let blockClaims = false
    let releaseClaim: () => void = () => undefined
    const claimBlocked = vi.fn()
    const queueState = new Proxy(state, {
      get(target, property) {
        if (property === "claimWebhookDelivery") {
          return async (...args: Parameters<typeof state.claimWebhookDelivery>) => {
            if (blockClaims) {
              claimBlocked()
              await new Promise<void>(resolve => {
                releaseClaim = resolve
              })
            }
            return await state.claimWebhookDelivery(...args)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    let activeSignal: AbortSignal | undefined
    const run = vi.fn(async ({ input }: { input: { abortSignal?: AbortSignal } }) => {
      const abortSignal = input.abortSignal
      if (!abortSignal) throw new Error("Expected queue ownership to provide an abort signal.")
      activeSignal = abortSignal
      await new Promise<void>((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
      })
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "stop" },
                webhook: {
                  concurrencyLimit: 1,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (deliveryId: string) => new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
      },
      method: "POST",
    })
    let stop: () => void | Promise<void> = () => undefined

    try {
      await handler(request("delivery-stop-1"), "github", { agentName: "review", webhookState: queueState })
      stop = handler.resume({ agentName: "review", webhookState: queueState })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 3_000 })
      blockClaims = true
      await handler(request("delivery-stop-2"), "github", { agentName: "review", webhookState: queueState })
      await vi.waitFor(() => expect(claimBlocked).toHaveBeenCalled())

      let stopped = false
      const stopping = Promise.resolve(stop()).then(() => {
        stopped = true
      })
      await Promise.resolve()
      expect(stopped).toBe(false)
      releaseClaim()
      await stopping
      expect(activeSignal?.aborted).toBe(true)
      expect(run).toHaveBeenCalledOnce()

      const first = await state.claimWebhookDelivery("webhook:review:github:github:")
      expect(first?.deliveryId).toBe("delivery-stop-1")
      await state.completeWebhookDelivery(first!.scope, first!.deliveryId, first!.leaseToken)
      await expect(state.claimWebhookDelivery(first!.scope)).resolves.toMatchObject({ deliveryId: "delivery-stop-2" })
    }
    finally {
      stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("retries transient webhook lease heartbeat contention without aborting the run", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-heartbeat-busy-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const extendLease = vi.fn(state.extendWebhookDeliveryLease.bind(state))
    extendLease.mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))
    const busyState = new Proxy(state, {
      get(target, property) {
        if (property === "extendWebhookDeliveryLease") return extendLease
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    let abortSignal: AbortSignal | undefined
    let releaseRun!: () => void
    const activeRun = new Promise<void>(resolve => {
      releaseRun = resolve
    })
    const run = vi.fn(async ({ input }: { input: { abortSignal?: AbortSignal } }) => {
      abortSignal = input.abortSignal
      await activeRun
      return "accepted"
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "heartbeat" },
                webhook: {
                  concurrencyLimit: 1,
                  concurrencyTtlMs: 1_000,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    let stop: () => void | Promise<void> = () => undefined

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"))
      stop = handler.resume({ agentName: "review", webhookState: busyState })
      const response = await handler(new Request("https://example.com/api/github/webhook", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-busy",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", { agentName: "review", webhookState: busyState })
      expect(response.status).toBe(200)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await vi.advanceTimersByTimeAsync(500)
      expect(extendLease).toHaveBeenCalledOnce()
      expect(abortSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(250)
      expect(extendLease).toHaveBeenCalledTimes(2)
      expect(abortSignal?.aborted).toBe(false)
    }
    finally {
      releaseRun()
      await stop()
      vi.clearAllTimers()
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("retries a failed queued webhook delivery", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-retry-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const completeDelivery = vi.spyOn(state, "completeWebhookDelivery")
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue("accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "retry" },
                webhook: {
                  concurrencyLimit: 1,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    let stop: () => void = () => undefined
    const request = () => new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-retry",
        "x-github-event": "pull_request",
      },
      method: "POST",
    })

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"))
      stop = handler.resume({ agentName: "review", webhookState: state })
      await expect(handler(request(), "github", { agentName: "review", webhookState: state })).resolves.toMatchObject({ status: 200 })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(completeDelivery).toHaveBeenCalledOnce())
      await expect(completeDelivery.mock.results[0]?.value).resolves.toBe(true)

      const duplicate = await handler(request(), "github", { agentName: "review", webhookState: state })
      await expect(duplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true, queued: false })
    }
    finally {
      stop()
      consoleError.mockRestore()
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("retries a failed queued webhook delivery without the startup pump", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-route-retry-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue("accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "retry" },
                webhook: {
                  concurrencyLimit: 1,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntil = vi.fn((_task: Promise<unknown>) => undefined)

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"))
      await handler(new Request("https://example.com/api/github/webhook", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-route-retry",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", { agentName: "review", webhookState: state, waitUntil })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(waitUntil.mock.calls.length).toBeGreaterThanOrEqual(3))

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(waitUntil.mock.calls.length).toBeGreaterThanOrEqual(3))
      const settledWaitUntilCount = waitUntil.mock.calls.length
      await vi.advanceTimersByTimeAsync(1_000)
      expect(waitUntil).toHaveBeenCalledTimes(settledWaitUntilCount)
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("rejects webhook steering without keyed concurrency ownership", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const request = () => new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "invalid-steer",
        "x-github-event": "pull_request",
      },
      method: "POST",
    })

    for (const webhook of [
      { busy: "steer", concurrencyLimit: 1, deliveryId: "invalid-steer" },
      { busy: "steer", concurrencyKey: "shared", deliveryId: "invalid-steer" },
    ]) {
      const handler = createChannelWebhookRouteHandler(defineAgent({
        channels: {
          github: github({
            triggers: { webhook: { invoke: () => ({ input: { prompt: "ignored" }, webhook } as never) } },
            webhooks: { secretToken: false },
          }),
        },
        driver: { run: vi.fn() },
      }) as never)

      const response = await handler(request(), "github")
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({ error: true, message: 'Webhook busy: "steer" requires concurrencyKey and concurrencyLimit.' })
    }
  })

  it("claims webhook deliveries and exact-context concurrency before running the agent", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-ownership-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const getState = vi.spyOn(state, "get")
    const acquireLock = vi.spyOn(state, "acquireLock")
    const extendLock = vi.spyOn(state, "extendLock")
    let releaseFirstRun!: () => void
    const firstRun = new Promise<void>(resolve => {
      releaseFirstRun = resolve
    })
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) await firstRun
      return "accepted"
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                const deliveryId = (input as { github?: { deliveryId?: string } }).github?.deliveryId || ""
                return {
                  input: { prompt: "github delivery" },
                  webhook: {
                    concurrencyKey: "acme/app:42:head-sha",
                    deliveryId,
                  },
                }
              },
            },
          },
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []
    const webhookStateContexts: unknown[] = []
    const request = (deliveryId: string) => {
      const body = JSON.stringify({ action: "labeled" })
      return new Request("https://example.com/api/github/webhook", {
        body,
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "pull_request",
          "x-hub-signature-256": githubSignature("secret-token", body),
        },
        method: "POST",
      })
    }
    const options = {
      agentName: "review",
      webhookState: (context: unknown) => {
        webhookStateContexts.push(context)
        return state
      },
      waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task),
    }

    try {
      vi.useFakeTimers()
      const accepted = await handler(request("delivery-1"), "github", options)
      await expect(accepted.json()).resolves.toEqual({ accepted: true, ok: true })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(acquireLock).toHaveBeenCalledWith("webhook:review:github:github:lease:acme/app:42:head-sha", 30_000)
      await vi.advanceTimersByTimeAsync(15_000)

      const concurrentDuplicate = await handler(request("delivery-1"), "github", options)
      await expect(concurrentDuplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true })

      const busy = await handler(request("delivery-2"), "github", options)
      expect(busy.status).toBe(503)
      await expect(busy.json()).resolves.toEqual({ accepted: false, busy: true, ok: true })
      expect(extendLock).toHaveBeenCalled()
      expect(run).toHaveBeenCalledOnce()

      releaseFirstRun()
      await Promise.all(waitUntilTasks.splice(0))

      const duplicate = await handler(request("delivery-1"), "github", options)
      await expect(duplicate.json()).resolves.toEqual({ accepted: false, duplicate: true, ok: true })

      const rerun = await handler(request("delivery-2"), "github", options)
      await expect(rerun.json()).resolves.toEqual({ accepted: true, ok: true })
      await Promise.all(waitUntilTasks)
      expect(run).toHaveBeenCalledTimes(2)
      await expect(state.get("webhook:review:github:github:delivery:delivery-1")).resolves.toBe(true)
      await expect(state.get("webhook:review:github:github:delivery:delivery-2")).resolves.toBe(true)
      expect(webhookStateContexts[0]).toMatchObject({
        webhook: {
          agentName: "review",
          channelId: "github",
          provider: "github",
          stateKeyPrefix: "webhook:review:github:github:",
        },
      })
      expect(getState).not.toHaveBeenCalledWith("webhook:backend-id")
    }
    finally {
      releaseFirstRun()
      await Promise.allSettled(waitUntilTasks)
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("aborts an inline webhook run when its ownership lease is lost", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-lost-lease-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const extendLock = vi.fn(async () => false)
    const losingState = new Proxy(state, {
      get(target, property) {
        if (property === "extendLock") return extendLock
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    let abortSignal: AbortSignal | undefined
    const run = vi.fn(async ({ input }: { input: { abortSignal?: AbortSignal } }) => {
      if (run.mock.calls.length > 1) return "accepted"
      abortSignal = input.abortSignal
      if (!abortSignal?.aborted) {
        await new Promise<void>(resolve => abortSignal?.addEventListener("abort", () => resolve(), { once: true }))
      }
      return "aborted"
    })
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: (_context, input) => ({
                input: { prompt: "github delivery" },
                webhook: {
                  concurrencyKey: "acme/app:42:head-sha",
                  concurrencyTtlMs: 1_000,
                  deliveryId: (input as { github: { deliveryId: string } }).github.deliveryId,
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []
    const request = (deliveryId: string) => new Request("https://example.com/api/github/webhook", {
      body: JSON.stringify({ action: "labeled" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
      },
      method: "POST",
    })
    const options = {
      agentName: "review",
      webhookState: losingState,
      waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task),
    }

    try {
      vi.useFakeTimers()
      const accepted = await handler(request("delivery-1"), "github", options)
      await expect(accepted.json()).resolves.toEqual({ accepted: true, ok: true })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(500)
      await Promise.all(waitUntilTasks.splice(0))

      expect(extendLock).toHaveBeenCalledOnce()
      expect(abortSignal?.aborted).toBe(true)

      const rerun = await handler(request("delivery-2"), "github", options)
      await expect(rerun.json()).resolves.toEqual({ accepted: true, ok: true })
      await Promise.all(waitUntilTasks)
      expect(run).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("fails closed when webhook ownership has no durable state", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({
                input: { prompt: "github delivery" },
                webhook: { deliveryId: "delivery-1" },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/github/webhook", {
      body: JSON.stringify({ action: "labeled" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
      method: "POST",
    }), "github")

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      message: "Durable Agent state is required for webhook delivery ownership.",
      status: 503,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("fails closed before queueing workflow-backed webhook concurrency", async () => {
    const { defineAgent, workflow } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({
                input: { prompt: "github delivery" },
                webhook: {
                  concurrencyKey: "acme/app:42:head-sha",
                  deliveryId: "delivery-1",
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
      runtime: workflow("review"),
    })

    const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/github/webhook", {
      body: JSON.stringify({ action: "labeled" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
      method: "POST",
    }), "github")

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      message: "Webhook concurrency ownership requires inline Agent execution.",
      status: 503,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("retries persisted webhook concurrency after an Agent changes to a Workflow runtime", async () => {
    const { defineAgent, workflow } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-workflow-transition-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const retry = vi.spyOn(state, "retryWebhookDelivery")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: { webhook: { invoke: () => ({ input: { prompt: "github delivery" } }) } },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
      runtime: workflow("review"),
    })
    await state.connect()
    await state.enqueueWebhookDelivery({
      concurrencyGroup: "review:default",
      concurrencyLimit: 1,
      deliveryId: "delivery-before-workflow",
      enqueuedAt: Date.now(),
      invocation: { input: { prompt: "persisted" } },
      leaseTtlMs: 30_000,
      request: {
        body: JSON.stringify({ action: "labeled" }),
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-before-workflow",
          "x-github-event": "pull_request",
        },
        method: "POST",
        url: "https://example.com/api/github/webhook",
      },
      scope: "webhook:review:github:github:",
      webhookId: "github",
    })
    const stop = createChannelWebhookRouteHandler(agent as never).resume({ agentName: "review", webhookState: state })

    try {
      await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
      expect(run).not.toHaveBeenCalled()
    }
    finally {
      await stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("retries a rehydration-required delivery when replay handles the request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-rehydrate-handled-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const retry = vi.spyOn(state, "retryWebhookDelivery")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: { webhook: { invoke: () => new Response(null, { status: 204 }) } },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    await state.connect()
    await state.enqueueWebhookDelivery({
      concurrencyGroup: "review:default",
      concurrencyLimit: 1,
      deliveryId: "delivery-rehydrate-handled",
      enqueuedAt: Date.now(),
      leaseTtlMs: 30_000,
      rehydrate: true,
      request: {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-rehydrate-handled",
          "x-github-event": "pull_request",
        },
        method: "POST",
        url: "https://example.com/api/github/webhook",
      },
      scope: "webhook:review:github:github:",
      webhookId: "github",
    })
    const stop = createChannelWebhookRouteHandler(agent as never).resume({ agentName: "review", webhookState: state })

    try {
      await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
      expect(run).not.toHaveBeenCalled()
    }
    finally {
      await stop()
      consoleError.mockRestore()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("resumes persisted invocations after the final webhook registration is removed", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-removed-registration-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({ driver: { run } })
    await state.connect()
    await state.enqueueWebhookDelivery({
      concurrencyGroup: "review:default",
      concurrencyLimit: 1,
      deliveryId: "delivery-for-removed-registration",
      enqueuedAt: Date.now(),
      invocation: { input: { prompt: "persisted" } },
      leaseTtlMs: 30_000,
      request: { body: "{}", headers: {}, method: "POST", url: "https://example.com" },
      scope: "webhook:review:github:removed-registration:",
      webhookId: "removed-registration",
    })
    const stop = createChannelWebhookRouteHandler(agent as never).resume({ agentName: "review", webhookState: state })

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    }
    finally {
      await stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("periodically discovers persisted scopes only for the exact resumed Agent", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-agent-scope-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: { webhook: { invoke: () => ({ input: { prompt: "github delivery" } }) } },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    await state.connect()
    await state.enqueueWebhookDelivery({
      concurrencyGroup: "other:default",
      concurrencyLimit: 1,
      deliveryId: "delivery-for-other-agent",
      enqueuedAt: Date.now(),
      invocation: { input: { prompt: "persisted" } },
      leaseTtlMs: 30_000,
      request: {
        body: JSON.stringify({ action: "labeled" }),
        headers: { "content-type": "application/json" },
        method: "POST",
        url: "https://example.com/api/github/webhook",
      },
      scope: "webhook:review%3Atriage%3Achild:github:github:",
      webhookId: "github",
    })
    const claim = vi.spyOn(state, "claimWebhookDelivery")
    const stop = createChannelWebhookRouteHandler(agent as never).resume({ agentName: "review:triage", webhookState: state })

    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalledWith("webhook:review%3Atriage:github:github:"))
      expect(claim).not.toHaveBeenCalledWith("webhook:review%3Atriage%3Achild:github:github:")
      await state.enqueueWebhookDelivery({
        concurrencyGroup: "review:default",
        concurrencyLimit: 1,
        deliveryId: "delivery-created-after-discovery",
        enqueuedAt: Date.now(),
        invocation: { input: { prompt: "persisted" } },
        leaseTtlMs: 30_000,
        request: { body: "{}", headers: {}, method: "POST", url: "https://example.com" },
        scope: "webhook:review%3Atriage:github:removed-registration:",
        webhookId: "removed-registration",
      })
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 2_000 })
      expect(claim).not.toHaveBeenCalledWith("webhook:review%3Atriage%3Achild:github:github:")
    }
    finally {
      await stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("keeps capability-bound default Workflow webhook runs inline", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-inline-workflow-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({
                input: { prompt: "github delivery" },
                webhook: {
                  concurrencyKey: "acme/app:42:head-sha",
                  deliveryId: "delivery-1",
                },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const waitUntilTasks: Promise<unknown>[] = []
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/api/github/webhook", {
        body: JSON.stringify({ action: "labeled" }),
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
        },
        method: "POST",
      }), "github", {
        agentIdentity: { name: "review" },
        capabilities: { kv: {} as never },
        webhookState: state,
        waitUntil: task => waitUntilTasks.push(task),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ accepted: true, ok: true })
      await Promise.all(waitUntilTasks)
      expect(run).toHaveBeenCalledOnce()
    }
    finally {
      resetWorkflowRuntime()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
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
    }), "support", {
      cloudflare: { env: {} },
      waitUntil: () => undefined,
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: "Unknown ViteHub agent webhook.", status: 404 })
  })

  it("isolates delivery claims between webhook registrations", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-registration-ownership-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(() => "accepted")
    const agent = defineAgent({
      channels: {
        "support:team": github({
          triggers: {
            webhook: {
              invoke: () => ({
                input: { prompt: "handle delivery" },
                webhook: { deliveryId: "shared-delivery" },
              }),
            },
          },
          webhooks: [
            { id: "primary:one", path: "/api/support/primary", secretToken: false },
            { id: "fallback:two", path: "/api/support/fallback", secretToken: false },
          ],
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const waitUntilTasks: Promise<unknown>[] = []
    const options = {
      agentName: "support",
      webhookState: state,
      waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task),
    }

    try {
      const primary = await handler(new Request("https://example.com/webhook", { method: "POST" }), "primary:one", options)
      const fallback = await handler(new Request("https://example.com/webhook", { method: "POST" }), "fallback:two", options)

      await expect(primary.json()).resolves.toEqual({ accepted: true, ok: true })
      await expect(fallback.json()).resolves.toEqual({ accepted: true, ok: true })
      await Promise.all(waitUntilTasks)
      expect(run).toHaveBeenCalledTimes(2)
      await expect(state.get("webhook:support:support%3Ateam:primary%3Aone:delivery:shared-delivery")).resolves.toBe(true)
      await expect(state.get("webhook:support:support%3Ateam:fallback%3Atwo:delivery:shared-delivery")).resolves.toBe(true)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
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

  it("scopes framework chat state by agent and channel", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-state-scope-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const miniRun = vi.fn(() => "mini")
    const brujulaRun = vi.fn(() => "brujula")
    const handler = (run: () => string, explicitState?: typeof state) => createChannelWebhookRouteHandler(defineAgent({
      channels: {
        discord: http({ adapter: () => createTestChatAdapter() as never }),
        slack: http({ adapter: () => createTestChatAdapter() as never }),
      },
      driver: { run },
      messages: { ...(explicitState ? { state: explicitState } : {}), stream: false },
    }) as never)
    const request = () => new Request("https://example.com/api/_vitehub/agents/mini/webhooks/discord", {
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

    try {
      const mini = handler(miniRun)
      const brujula = handler(brujulaRun)
      await expect(mini(request(), "discord", { agentName: "mini", state })).resolves.toMatchObject({ status: 200 })
      await expect(brujula(request(), "discord", { agentName: "work-coordinator", state })).resolves.toMatchObject({ status: 200 })
      await expect(mini(request(), "discord", { agentName: "mini", state })).resolves.toMatchObject({ status: 200 })
      await expect(mini(request(), "slack", { agentName: "mini", state })).resolves.toMatchObject({ status: 200 })

      expect(miniRun).toHaveBeenCalledTimes(2)
      expect(brujulaRun).toHaveBeenCalledOnce()
      await expect(state.get("chat:mini:discord:dedupe:telegram:7")).resolves.toBe(true)
      await expect(state.get("chat:mini:slack:dedupe:telegram:7")).resolves.toBe(true)
      await expect(state.get("chat:work-coordinator:discord:dedupe:telegram:7")).resolves.toBe(true)
      await expect(state.get("dedupe:telegram:7")).resolves.toBeNull()

      const prefixes: string[] = []
      const resolvedRun = vi.fn(() => "resolved")
      await expect(handler(resolvedRun)(request(), "discord", {
        agentName: "resolved",
        state: (context) => {
          prefixes.push(context.chat.stateKeyPrefix)
          return state
        },
      })).resolves.toMatchObject({ status: 200 })
      expect(prefixes).toEqual(["chat:resolved:discord:"])
      expect(resolvedRun).toHaveBeenCalledOnce()
      await expect(state.get("dedupe:telegram:7")).resolves.toBe(true)
      await expect(state.get("chat:resolved:discord:dedupe:telegram:7")).resolves.toBeNull()
      await state.delete("dedupe:telegram:7")

      const explicitRun = vi.fn(() => "explicit")
      await expect(handler(explicitRun, state)(request(), "discord", { agentName: "explicit", state })).resolves.toMatchObject({ status: 200 })
      expect(explicitRun).toHaveBeenCalledOnce()
      await expect(state.get("dedupe:telegram:7")).resolves.toBe(true)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("shares explicit-identity transcripts across channels while isolating agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-transcript-scope-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const createHandler = (discordAdapter: ReturnType<typeof createTestChatAdapter>, slackAdapter: ReturnType<typeof createTestChatAdapter>) => createChannelWebhookRouteHandler(defineAgent({
      channels: {
        discord: http({ adapter: () => discordAdapter as never }),
        slack: http({ adapter: () => slackAdapter as never }),
      },
      driver: { run: () => "ok" },
      messages: {
        identity: () => "account:verified",
        stream: false,
        transcripts: { maxPerUser: 50, retention: "30d" },
      },
    }) as never)
    const miniDiscord = createTestChatAdapter()
    const miniSlack = createTestChatAdapter()
    const mini = createHandler(miniDiscord, miniSlack)
    const coordinatorDiscord = createTestChatAdapter()
    const coordinator = createHandler(coordinatorDiscord, createTestChatAdapter())

    try {
      await expect(mini(chatWebhookRequest(71, 456, "discord"), "discord", { agentName: "mini", state })).resolves.toMatchObject({ status: 200 })
      await expect(mini(chatWebhookRequest(72, 789, "slack"), "slack", { agentName: "mini", state })).resolves.toMatchObject({ status: 200 })
      await expect(coordinator(chatWebhookRequest(73, 456, "other agent"), "discord", { agentName: "work-coordinator", state })).resolves.toMatchObject({ status: 200 })

      const miniDiscordTranscripts = miniDiscord._chatInstance()!.transcripts
      const miniSlackTranscripts = miniSlack._chatInstance()!.transcripts
      const coordinatorTranscripts = coordinatorDiscord._chatInstance()!.transcripts
      await miniDiscordTranscripts.append(
        { adapter: { name: "discord" }, id: "discord:456" } as never,
        { role: "user", text: "discord" },
        { userKey: "account:verified" },
      )
      await miniSlackTranscripts.append(
        { adapter: { name: "slack" }, id: "slack:789" } as never,
        { role: "user", text: "slack" },
        { userKey: "account:verified" },
      )
      await coordinatorTranscripts.append(
        { adapter: { name: "discord" }, id: "discord:456" } as never,
        { role: "user", text: "other agent" },
        { userKey: "account:verified" },
      )

      await expect(miniSlackTranscripts.count({ userKey: "account:verified" })).resolves.toBe(2)
      await expect(miniSlackTranscripts.list({ userKey: "account:verified" })).resolves.toMatchObject([
        { platform: "discord", text: "discord" },
        { platform: "slack", text: "slack" },
      ])
      await expect(state.getList("chat:mini:transcripts:user:account:verified")).resolves.toHaveLength(2)
      await expect(state.getList("chat:work-coordinator:transcripts:user:account:verified")).resolves.toHaveLength(1)
      await expect(state.getList("chat:mini:discord:transcripts:user:account:verified")).resolves.toEqual([])
      await expect(state.getList("chat:mini:slack:transcripts:user:account:verified")).resolves.toEqual([])
      await expect(miniSlackTranscripts.delete({ userKey: "account:verified" })).resolves.toEqual({ deleted: 2 })
      await expect(miniDiscordTranscripts.list({ userKey: "account:verified" })).resolves.toEqual([])
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("delivers state-backed Chat SDK titles once per thread across handler recreation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-once-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const setThreadTitle = vi.fn(async () => undefined)
    const execute = vi.fn(({ text }: { text: string }) => `Title: ${text}`)
    const run = vi.fn(() => "ok")
    const finish = vi.fn()
    const createHandler = () => createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ execute })],
      channels: {
        channel: http({ adapter: () => createTitleChatAdapter(setThreadTitle) as never }),
      },
      driver: { run },
      hooks: { "agent:finish": finish },
      messages: { state, stream: false, triggerHistory: "none" },
    }) as never)

    try {
      const first = createHandler()
      await expect(first(chatWebhookRequest(101, 456, "first"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(first(chatWebhookRequest(102, 456, "second"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      expect(run).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenCalledOnce()
      expect(setThreadTitle).toHaveBeenCalledOnce()
      expect(finish.mock.calls[0]![0].extensions.get("title")).toEqual({ title: "Title: first" })
      expect(finish.mock.calls[1]![0].extensions.get("title")).toBeUndefined()

      const recreated = createHandler()
      await expect(recreated(chatWebhookRequest(103, 456, "third"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(recreated(chatWebhookRequest(104, 789, "other thread"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })

      expect(setThreadTitle).toHaveBeenCalledTimes(2)
      expect(setThreadTitle).toHaveBeenNthCalledWith(1, "telegram:456", "Title: first")
      expect(setThreadTitle).toHaveBeenNthCalledWith(2, "telegram:789", "Title: other thread")
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(state.get("chat:mini:channel:channel-title:telegram:456:delivered")).resolves.toBe(true)
      await expect(state.get("chat:mini:channel:channel-title:telegram:789:delivered")).resolves.toBe(true)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("releases a Title claim when the post-lock marker read fails", async () => {
    const {
      claimMessageChannelTitleDelivery,
      messageChannelStateContextKey,
    } = await import("../src/internal/channels.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const readError = new Error("title marker read failed")
    const lock = { expiresAt: Date.now() + 60_000, threadId: "title:pending", token: "lock" }
    const state = {
      acquireLock: vi.fn(async () => lock),
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(readError),
      releaseLock: vi.fn(async () => undefined),
    }
    const context = createAgentInvocationContextStore()
    context.set(messageChannelStateContextKey, { keyPrefix: "chat:mini:discord:", state })

    await expect(claimMessageChannelTitleDelivery(context, { threadId: "discord:123" } as never)).resolves.toEqual({
      deliver: true,
      error: readError,
    })
    expect(state.releaseLock).toHaveBeenCalledWith(lock)
  })

  it("clears a delivered Title claim before marking a failed Channel", async () => {
    const {
      finishMessageChannelTitleDelivery,
      resetMessageChannelTitleDelivery,
    } = await import("../src/internal/channels.ts")
    const lock = { expiresAt: Date.now() + 60_000, threadId: "title:pending", token: "lock" }
    const state = {
      delete: vi.fn(async () => undefined),
      releaseLock: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    }
    const attempt = {
      claim: { lock, markerKey: "channel-title:thread:delivered", state },
      deliver: true,
    }

    await finishMessageChannelTitleDelivery(attempt as never, true)
    await resetMessageChannelTitleDelivery(attempt as never)

    expect(state.set).toHaveBeenCalledWith("channel-title:thread:delivered", true)
    expect(state.delete).toHaveBeenCalledWith("channel-title:thread:delivered")
  })

  it("does not redeliver a Title when marker observation succeeds but lock release fails", async () => {
    const {
      claimMessageChannelTitleDelivery,
      messageChannelStateContextKey,
    } = await import("../src/internal/channels.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const releaseError = new Error("title lock release failed")
    const lock = { expiresAt: Date.now() + 60_000, threadId: "title:pending", token: "lock" }
    const state = {
      acquireLock: vi.fn(async () => lock),
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(true),
      releaseLock: vi.fn(async () => { throw releaseError }),
    }
    const context = createAgentInvocationContextStore()
    context.set(messageChannelStateContextKey, { keyPrefix: "chat:mini:discord:", state })

    await expect(claimMessageChannelTitleDelivery(context, { threadId: "discord:123" } as never)).resolves.toEqual({
      deliver: false,
      error: releaseError,
      reason: "already-delivered",
    })
  })

  it("releases failed title delivery claims for finish and later webhook retries", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-retry-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const setThreadTitle = vi.fn()
      .mockRejectedValueOnce(new Error("early delivery failed"))
      .mockRejectedValueOnce(new Error("finish delivery failed"))
      .mockResolvedValue(undefined)
    const handler = createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ execute: ({ text }) => `Title: ${text}` })],
      channels: {
        channel: http({ adapter: () => createTitleChatAdapter(setThreadTitle) as never }),
      },
      driver: { run: () => "ok" },
      messages: { state, stream: false, triggerHistory: "none" },
    }) as never)

    try {
      await expect(handler(chatWebhookRequest(111, 456, "first"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(state.get("chat:mini:channel:channel-title:telegram:456:delivered")).resolves.toBeNull()

      await expect(handler(chatWebhookRequest(112, 456, "retry"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      expect(setThreadTitle).toHaveBeenCalledTimes(3)
      expect(setThreadTitle).toHaveBeenLastCalledWith("telegram:456", "Title: retry")
      await expect(state.get("chat:mini:channel:channel-title:telegram:456:delivered")).resolves.toBe(true)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("claims concurrent Chat SDK title delivery atomically", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-concurrent-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    let releaseDelivery: () => void = () => {}
    const deliveryPending = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const setThreadTitle = vi.fn(async () => await deliveryPending)
    const execute = vi.fn(({ text }: { text: string }) => `Title: ${text}`)
    const messageState = (prefix: string) => new Proxy(state, {
      get(target, property) {
        if (property === "acquireLock") {
          return (threadId: string, ttlMs: number) => target.acquireLock(
            threadId.includes("channel-title:") ? threadId : `${prefix}:${threadId}`,
            ttlMs,
          )
        }
        if (property === "forceReleaseLock") {
          return (threadId: string) => target.forceReleaseLock(
            threadId.includes("channel-title:") ? threadId : `${prefix}:${threadId}`,
          )
        }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const createHandler = (prefix: string, adapter: ReturnType<typeof createTitleChatAdapter>) => createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ execute })],
      channels: {
        channel: http({ adapter: () => adapter as never }),
      },
      driver: { run: () => "ok" },
      messages: { state: messageState(prefix), stream: false, triggerHistory: "none" },
    }) as never)
    const firstAdapter = createTitleChatAdapter(setThreadTitle)
    const secondAdapter = createTitleChatAdapter(setThreadTitle)
    const firstHandler = createHandler("first", firstAdapter)
    const secondHandler = createHandler("second", secondAdapter)

    try {
      const first = firstHandler(chatWebhookRequest(121, 456, "first"), "channel", { agentName: "mini" })
      await vi.waitFor(() => expect(setThreadTitle).toHaveBeenCalledOnce())
      const second = secondHandler(chatWebhookRequest(122, 456, "second"), "channel", { agentName: "mini" })
      await vi.waitFor(() => expect(secondAdapter.postMessage).toHaveBeenCalled())
      expect(setThreadTitle).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledOnce()

      releaseDelivery()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(setThreadTitle).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledOnce()
      await expect(state.get("chat:mini:channel:channel-title:telegram:456:delivered")).resolves.toBe(true)
    }
    finally {
      releaseDelivery()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("isolates title delivery by agent and channel on shared explicit state", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-scope-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const setThreadTitle = vi.fn(async () => undefined)
    const handler = (channel: string) => createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ execute: () => `${channel} title` })],
      channels: {
        [channel]: http({ adapter: () => createTitleChatAdapter(setThreadTitle) as never }),
      },
      driver: { run: () => "ok" },
      messages: { state, stream: false, triggerHistory: "none" },
    }) as never)

    try {
      await expect(handler("discord")(chatWebhookRequest(131), "discord", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(handler("slack")(chatWebhookRequest(132), "slack", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(handler("discord")(chatWebhookRequest(133), "discord", { agentName: "work-coordinator" })).resolves.toMatchObject({ status: 200 })

      expect(setThreadTitle).toHaveBeenCalledTimes(3)
      await expect(state.get("chat:mini:discord:channel-title:telegram:456:delivered")).resolves.toBe(true)
      await expect(state.get("chat:mini:slack:channel-title:telegram:456:delivered")).resolves.toBe(true)
      await expect(state.get("chat:work-coordinator:discord:channel-title:telegram:456:delivered")).resolves.toBe(true)
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("can deliver state-backed Chat SDK titles on every invocation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-always-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const setThreadTitle = vi.fn(async () => undefined)
    const handler = createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ channelDelivery: "always", execute: ({ text }) => `Title: ${text}` })],
      channels: {
        channel: http({ adapter: () => createTitleChatAdapter(setThreadTitle) as never }),
      },
      driver: { run: () => "ok" },
      messages: { state, stream: false, triggerHistory: "none" },
    }) as never)

    try {
      await expect(handler(chatWebhookRequest(141, 456, "first"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      await expect(handler(chatWebhookRequest(142, 456, "second"), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })

      expect(setThreadTitle).toHaveBeenCalledTimes(2)
      expect(setThreadTitle).toHaveBeenNthCalledWith(1, "telegram:456", "Title: first")
      expect(setThreadTitle).toHaveBeenNthCalledWith(2, "telegram:456", "Title: second")
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("keeps Chat SDK output and best-effort title delivery when title state coordination fails", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { title } = await import("../src/capabilities.ts")
    const { http } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-title-state-failure-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const failingState = new Proxy(state, {
      get(target, property) {
        if (property === "get") {
          return async (key: string) => {
            if (key.includes("channel-title:")) throw new Error("title state unavailable")
            return await target.get(key)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const setThreadTitle = vi.fn(async () => undefined)
    const adapter = createTitleChatAdapter(setThreadTitle)
    const handler = createChannelWebhookRouteHandler(defineAgent({
      capabilities: [title({ execute: () => "Best effort title" })],
      channels: {
        channel: http({ adapter: () => adapter as never }),
      },
      driver: { run: () => "ok" },
      messages: { state: failingState, stream: false, triggerHistory: "none" },
    }) as never)

    try {
      await expect(handler(chatWebhookRequest(151), "channel", { agentName: "mini" })).resolves.toMatchObject({ status: 200 })
      expect(setThreadTitle).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "ok" })
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
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

  it("shows configured chat fallback while native adapter streams are pending", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.deleteMessage.mockRejectedValueOnce(new Error("try again"))
    let runStarted!: () => void
    let finishRun!: () => void
    const runStartedPromise = new Promise<void>(resolve => {
      runStarted = resolve
    })
    const finishRunPromise = new Promise<void>(resolve => {
      finishRun = resolve
    })
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
      let text = ""
      for await (const chunk of textStream) {
        if (typeof chunk === "string") text += chunk
        else if (chunk.type === "markdown_text") text += chunk.text
      }
      return { id: "stream-1", raw: { text }, threadId }
    })
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          fallbackStreamingPlaceholderText: "Working on it...",
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

    const responsePromise = handler(chatWebhookRequest(21046), "telegram")

    await runStartedPromise
    await Promise.resolve()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Working on it...")
    expect(adapter.deleteMessage).not.toHaveBeenCalled()

    finishRun()
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(adapter.deleteMessage).toHaveBeenNthCalledWith(1, "telegram:456", "sent-1")
    expect(adapter.deleteMessage).toHaveBeenNthCalledWith(2, "telegram:456", "sent-1")
    expect(adapter.stream).toHaveBeenCalledOnce()
  })

  it("hands the configured fallback back to Chat SDK when native streaming declines", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.stream = vi.fn(async () => null)
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          fallbackStreamingPlaceholderText: "Working on it...",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => "done" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(21047), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "Working on it...")
    expect(adapter.deleteMessage).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "done" })
  })

  it("does not retry an ambiguously failed streaming placeholder post", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockRejectedValueOnce(new Error("provider response lost"))
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          errorFallbackText: null,
          fallbackStreamingPlaceholderText: "Working on it...",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => "done" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(21050), "telegram")).rejects.toThrow("provider response lost")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Working on it...")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("does not retry an ambiguously failed native streaming placeholder post", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockRejectedValueOnce(new Error("provider response lost"))
    adapter.stream = vi.fn(async () => null)
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          errorFallbackText: null,
          fallbackStreamingPlaceholderText: "Working on it...",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => "done" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(21051), "telegram")).rejects.toThrow("provider response lost")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Working on it...")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("does not block native output on slow fallback delivery or cleanup", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const backgroundTasks: Promise<unknown>[] = []
    let postPlaceholder!: (message: { id: string, raw: unknown, threadId: string }) => void
    let deletePlaceholder!: () => void
    adapter.postMessage.mockImplementationOnce(async () => await new Promise(resolve => {
      postPlaceholder = resolve
    }))
    adapter.deleteMessage.mockImplementationOnce(async () => await new Promise<void>(resolve => {
      deletePlaceholder = resolve
    }))
    adapter.stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
      for await (const _chunk of textStream) {}
      return { id: "stream-1", raw: {}, threadId }
    })
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          fallbackStreamingPlaceholderText: "Working on it...",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      driver: { run: async () => "done" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(21048), "telegram", {
      waitUntil: task => backgroundTasks.push(task),
    })

    expect(response.status).toBe(200)
    expect(backgroundTasks.length).toBeGreaterThan(1)
    expect(adapter.deleteMessage).not.toHaveBeenCalled()
    postPlaceholder({ id: "placeholder-1", raw: {}, threadId: "telegram:456" })
    await vi.waitFor(() => {
      expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "placeholder-1")
    })
    deletePlaceholder()
    await Promise.all(backgroundTasks)
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

  it("posts the sanitized rate-limit message to chat", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { ViteHubError } = await import("@vite-hub/runtime")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")

    try {
      for (const [index, message] of [undefined, "You've reached today's limit."].entries()) {
        const adapter = createTestChatAdapter({ deferMessageProcessing: true })
        const agent = defineAgent({
          capabilities: [
            defineChatCapability({
              platforms: { telegram: () => adapter as never },
              webhooks: { telegram: {} },
            }),
          ],
          driver: {
            run: () => {
              throw new ViteHubError("RATE_LIMIT_REJECTED", message || "Rate limit exceeded. Try again later.")
            },
          },
        })
        const handler = createChannelWebhookRouteHandler(agent as never)

        const tasks: Promise<unknown>[] = []
        const response = await handler(chatWebhookRequest(2001 + index), "telegram", {
          waitUntil: task => tasks.push(task),
        })
        expect(response.status).toBe(200)
        await Promise.all(tasks)

        expect(adapter.postMessage).toHaveBeenLastCalledWith(
          "telegram:456",
          "Rate limit exceeded. Try again later.",
        )
      }
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("keeps name-spoofed rate-limit errors behind the generic chat fallback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ deferMessageProcessing: true })
    const waitUntilTasks: Promise<unknown>[] = []
    const error = new Error("internal details")
    error.name = "RateLimitRejectedError"
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
          platforms: { telegram: () => adapter as never },
          webhooks: { telegram: {} },
        }),
      ],
      driver: { run: () => { throw error } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = await handler(chatWebhookRequest(2003), "telegram", {
        waitUntil: task => waitUntilTasks.push(task),
      })
      expect(response.status).toBe(200)
      await Promise.all(waitUntilTasks)
      expect(adapter.postMessage).toHaveBeenLastCalledWith("telegram:456", "Sorry, I couldn't process that message.")
      expect(adapter.postMessage).not.toHaveBeenCalledWith("telegram:456", "internal details")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it.each([
    ["parallel", "concurrent"],
    ["drop", "drop"],
    ["queue", "queue"],
    ["serial", "queue"],
  ] as const)("maps ViteHub %s message concurrency to Chat SDK %s", async (concurrency, expectedConcurrency) => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { concurrency, stream: false },
        }),
      },
      driver: { run: () => "Agent output" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_003), "telegram")

    expect(response.status).toBe(200)
    expect((adapter._chatInstance() as unknown as { _concurrencyStrategy: string })._concurrencyStrategy).toBe(expectedConcurrency)
  })

  it("processes retained serial messages in queue order after an earlier failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-serial-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const extendLock = vi.spyOn(state, "extendLock")
    const adapter = createTestChatAdapter()
    const order: string[] = []
    const histories: string[][] = []
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    const firstPending = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const run = vi.fn(async ({ messages }) => {
      const texts = messages.map((message: { parts: Array<{ text?: string, type?: string }> }) =>
        message.parts.find(part => part.type === "text")?.text || "")
      const text = texts.at(-1) || ""
      histories.push(texts)
      order.push(text)
      if (text === "A") {
        firstStarted()
        await firstPending
        throw new Error("A failed")
      }
      return "ok"
    })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            concurrency: "serial",
            errorFallbackText: null,
            state,
            stream: false,
            triggerHistory: { maxMessages: 2, source: "thread" },
          },
        }),
      },
      driver: { run },
    }) as never)

    try {
      vi.useFakeTimers()
      await state.connect()
      const firstResponse = handler(chatWebhookRequest(91_010, 456, "A"), "telegram", { agentName: "support" })
      await firstStartedPromise
      await expect(handler(chatWebhookRequest(91_011, 456, "B"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      await vi.advanceTimersByTimeAsync(31_000)
      expect(extendLock).toHaveBeenCalled()
      await expect(handler(chatWebhookRequest(91_012, 456, "C"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      await expect(handler(chatWebhookRequest(91_013, 456, "D"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      expect(order).toEqual(["A"])

      releaseFirst()
      await expect(firstResponse).resolves.toMatchObject({ status: 200 })
      expect(order).toEqual(["A", "B", "C", "D"])
      expect(run).toHaveBeenCalledTimes(4)
      expect(histories).toEqual([["A"], ["B"], ["C"], ["D"]])
    }
    finally {
      releaseFirst()
      consoleError.mockRestore()
      vi.useRealTimers()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("preserves queued message threads with channel-scoped serial processing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-serial-threads-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const adapter = createTestChatAdapter({ isDM: false })
    vi.spyOn(adapter, "channelIdFromThreadId").mockReturnValue("telegram:channel")
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    const firstPending = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) {
        firstStarted()
        await firstPending
      }
      return "ok"
    })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            concurrency: "serial",
            lockScope: "channel",
            state,
            stream: false,
            triggerHistory: "none",
          },
        }),
      },
      driver: { run },
    }) as never)
    const request = (messageId: number, threadId: number, text: string) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: threadId, type: "group" },
          from: { id: messageId, username: `user-${messageId}` },
          isMention: true,
          message_id: messageId,
          text,
        },
      }),
      method: "POST",
    })

    try {
      await state.connect()
      const firstResponse = handler(request(91_015, 456, "A"), "telegram", { agentName: "support" })
      await firstStartedPromise
      await expect(handler(request(91_016, 789, "B"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      releaseFirst()
      await expect(firstResponse).resolves.toMatchObject({ status: 200 })

      expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", { markdown: "ok" })
      expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:789", { markdown: "ok" })
    }
    finally {
      releaseFirst()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("keeps queue concurrency coalesced", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-queue-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const adapter = createTestChatAdapter()
    const order: string[] = []
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    const firstPending = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const run = vi.fn(async ({ messages }) => {
      const text = messages[0]?.parts.find((part: { type?: string }) => part.type === "text") as { text?: string } | undefined
      order.push(text?.text || "")
      if (text?.text === "A") {
        firstStarted()
        await firstPending
      }
      return "ok"
    })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { concurrency: "queue", state, stream: false, triggerHistory: "none" },
        }),
      },
      driver: { run },
    }) as never)

    try {
      await state.connect()
      const firstResponse = handler(chatWebhookRequest(91_020, 456, "A"), "telegram", { agentName: "support" })
      await firstStartedPromise
      await expect(handler(chatWebhookRequest(91_021, 456, "B"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      await expect(handler(chatWebhookRequest(91_022, 456, "C"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })

      releaseFirst()
      await expect(firstResponse).resolves.toMatchObject({ status: 200 })
      await vi.waitFor(() => expect(order).toEqual(["A", "C"]))
      expect(run).toHaveBeenCalledTimes(2)
    }
    finally {
      releaseFirst()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("preserves mention and subscription eligibility for serial batches", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-serial-routing-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const adapter = createTestChatAdapter({ isDM: false })
    const routed: Array<{ deliveryKind: string, text: string }> = []
    const request = (messageId: number, text: string, isMention = false) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 456, type: "group" },
          from: { id: 123, username: "maxi" },
          isMention,
          message_id: messageId,
          text,
        },
      }),
      method: "POST",
    })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            concurrency: "serial",
            filter: ({ deliveryKind, message }) => {
              const text = message.parts.find(part => part.type === "text")
              routed.push({ deliveryKind, text: text?.type === "text" ? text.text : "" })
              return true
            },
            lockScope: "thread",
            state,
            stream: false,
            triggerHistory: "none",
          },
        }),
      },
      driver: { run: () => "ok" },
    }) as never)

    try {
      await state.connect()
      const lock = await state.acquireLock("telegram:456", 60_000)
      if (!lock) throw new Error("Expected the test lock to be acquired.")
      await expect(handler(request(91_030, "before mention"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      await expect(handler(request(91_031, "mention", true), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      await expect(handler(request(91_032, "after mention"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      expect(routed).toEqual([])

      await state.releaseLock(lock)
      await expect(handler(request(91_033, "drain"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })

      expect(routed).toEqual([
        { deliveryKind: "mention", text: "mention" },
        { deliveryKind: "subscribed", text: "after mention" },
      ])
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("preserves automatic chat delivery", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "automatic" },
        }),
      },
      driver: { run: () => "Agent output" },
      hooks: {
        "agent:finish": event => event.reply("Explicit reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_004), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", { markdown: "Agent output" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "Explicit reply" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("delivers only explicit manual replies and replaces the placeholder once", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(({ input }) => {
      expect(input.timeout).toBe(20)
      return "{\"internal\":\"structured output\"}"
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            timeout: 20,
          },
        }),
      },
      driver: { run },
      hooks: {
        "agent:finish": event => [
          event.reply("Calories reply"),
          event.reply("Dashboard reply"),
        ],
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_005), "telegram")

    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "Analyzing photo…")
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "Calories reply" })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "Dashboard reply" })
    expect(adapter.postMessage).not.toHaveBeenCalledWith("telegram:456", { markdown: "{\"internal\":\"structured output\"}" })
    expect(adapter.startTyping).toHaveBeenCalledWith("telegram:456", undefined)
    const typingOrder = adapter.startTyping.mock.invocationCallOrder[0]
    const fallbackOrder = adapter.postMessage.mock.invocationCallOrder[0]
    expect(typingOrder).toBeDefined()
    expect(fallbackOrder).toBeDefined()
    expect(typingOrder!).toBeLessThan(fallbackOrder!)
  })

  it("does not delay manual non-streaming delivery on a hung typing request", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.startTyping.mockImplementation(() => new Promise(() => {}))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "manual", stream: false },
        }),
      },
      driver: { run: () => "internal output" },
      hooks: {
        "agent:finish": event => event.reply("Explicit reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await Promise.race([
      handler(chatWebhookRequest(91_099), "telegram"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("webhook blocked on typing status")), 100)),
    ])

    expect(response.status).toBe(200)
    expect(adapter.startTyping).toHaveBeenCalledWith("telegram:456", undefined)
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Explicit reply" })
  })

  it("defers manual delivery to the active Agent Workflow by default", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const adapter = createTestChatAdapter()
    const waitUntilTasks: Array<Promise<unknown>> = []
    let observedTimeout: number | undefined | "not-run" = "not-run"
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "manual", timeout: 60_000 },
        }),
      },
      driver: { run: async ({ input }) => {
        observedTimeout = input.timeout
        await blocked
        return "internal output"
      } },
      hooks: {
        "agent:finish": event => event.reply("Durable reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "cloudflare" })

    try {
      const response = await Promise.race([
        handler(chatWebhookRequest(91_100), "telegram", {
          agentIdentity: { name: "calories" },
          cloudflare: { env: {} },
          waitUntil: task => waitUntilTasks.push(task),
        }),
        new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 100)),
      ])

      expect(response).not.toBe("blocked")
      if (response === "blocked") throw new Error("Durable chat delivery waited for Workflow completion.")
      expect(response.status).toBe(200)
      expect(adapter.postMessage).not.toHaveBeenCalled()
      release()
      await Promise.all(waitUntilTasks)
      await vi.waitFor(() => {
        expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Durable reply" })
      })
      expect(observedTimeout).toBe(60_000)
    }
    finally {
      release()
      resetWorkflowRuntime()
    }
  })

  it("keeps auto manual delivery inline when an explicit Agent Workflow is unavailable", async () => {
    const { defineAgent, workflow } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "internal output")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "manual" },
        }),
      },
      driver: { run },
      hooks: {
        "agent:finish": event => event.reply("Inline reply"),
      },
      runtime: workflow("calories"),
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_104), "telegram")

    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Inline reply" })
  })

  it("keeps auto manual delivery inline with nonportable capabilities on explicit Workflows", async () => {
    const { defineAgent, workflow } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "internal output")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "manual" },
        }),
      },
      driver: { run },
      hooks: {
        "agent:finish": event => event.reply("Inline reply"),
      },
      runtime: workflow("calories"),
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const response = await handler(chatWebhookRequest(91_103), "telegram", {
        agentIdentity: { name: "calories" },
        capabilities: { email: {} as never },
      })

      expect(response.status).toBe(200)
      expect(run).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Inline reply" })
    }
    finally {
      resetWorkflowRuntime()
    }
  })

  it("keeps durable: false manual delivery inline", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const adapter = createTestChatAdapter()
    const waitUntilTasks: Array<Promise<unknown>> = []
    let observedOrigin: string | undefined
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { delivery: "manual", durable: false },
        }),
      },
      driver: { run: (context) => {
        observedOrigin = context.run?.origin
        return "internal output"
      } },
      hooks: {
        "agent:finish": event => event.reply("Inline reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const response = await handler(chatWebhookRequest(91_101), "telegram", {
        agentIdentity: { name: "calories" },
        waitUntil: task => waitUntilTasks.push(task),
      })
      await Promise.all(waitUntilTasks)

      expect(response.status).toBe(200)
      expect(observedOrigin).toBe("telegram")
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Inline reply" })
    }
    finally {
      resetWorkflowRuntime()
    }
  })

  it("keeps serial manual delivery inline when an Agent Workflow is active", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-serial-inline-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const adapter = createTestChatAdapter()
    let observedOrigin: string | undefined
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { concurrency: "serial", delivery: "manual", state },
        }),
      },
      driver: { run: (context) => {
        observedOrigin = context.run?.origin
        return "internal output"
      } },
      hooks: {
        "agent:finish": event => event.reply("Inline reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      await state.connect()
      const response = await handler(chatWebhookRequest(91_102), "telegram", {
        agentIdentity: { name: "calories" },
      })

      expect(response.status).toBe(200)
      expect(observedOrigin).toBe("telegram")
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Inline reply" })
    }
    finally {
      resetWorkflowRuntime()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("keeps overlap-policy manual delivery inline when an Agent Workflow is active", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { resetWorkflowRuntime, setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
    const adapter = createTestChatAdapter()
    const run = vi.fn(() => "internal output")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: { concurrency: "drop", delivery: "manual" },
        }),
      },
      driver: { run },
      hooks: {
        "agent:finish": event => event.reply("Inline reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })

    try {
      const response = await handler(chatWebhookRequest(91_105), "telegram", {
        agentIdentity: { name: "calories" },
      })

      expect(response.status).toBe(200)
      expect(run).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", { markdown: "Inline reply" })
    }
    finally {
      resetWorkflowRuntime()
    }
  })

  it("uses generate for manual delivery without progress summaries", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const model = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "Generated result" })),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { delta: "Streamed result", type: "text-delta" }
          yield { finishReason: "stop", type: "finish" }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }
    const agent = {
      capabilities: [
        defineChatCapability({
          delivery: "manual",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      hooks: {
        "agent:finish": (event: { reply: (message: string) => unknown, result: { text: string } }) =>
          event.reply(event.result.text),
      },
      resolve: vi.fn(async () => model),
    }
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_017), "telegram")

    expect(response.status).toBe(200)
    expect(model.generate).toHaveBeenCalledOnce()
    expect(model.stream).not.toHaveBeenCalled()
  })

  it("streams manual progress summaries from invocation-resolved Capabilities", async () => {
    const { progressSummary } = await import("../src/capabilities/progress-summary.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const schema = {
      "~standard": {
        validate: (value: unknown) => typeof value === "object" && value !== null && "title" in value
          ? { value }
          : { issues: [{ message: "Expected a title." }] },
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const model = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { delta: "{\"title\":\"Private result\"}", type: "text-delta" }
          yield { finishReason: "stop", type: "finish" }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }
    const agent = {
      [Symbol.for("vitehub.baseAgentCapabilitiesResolver")]: () => [
        progressSummary({ driver: { run: () => "Reviewing the request." }, id: "progress-primary", intervalMs: 0 }),
        progressSummary({ driver: { run: () => "Still reviewing." }, id: "progress-secondary", intervalMs: 0 }),
      ],
      [Symbol.for("vitehub.baseAgentOutput")]: { schema },
      capabilities: [
        defineChatCapability({
          delivery: "manual",
          fallbackStreamingPlaceholderText: "Analyzing…",
          platforms: {
            telegram: () => adapter as never,
          },
          webhooks: {
            telegram: {},
          },
        }),
      ],
      resolve: vi.fn(async () => model),
    }
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_018), "telegram")

    expect(response.status).toBe(200)
    expect(model.generate).not.toHaveBeenCalled()
    expect(model.stream).toHaveBeenCalledOnce()
  })

  it("preserves validated structured output for explicit manual replies", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const schema = {
      "~standard": {
        validate: (value: unknown) => typeof value === "object"
          && value !== null
          && "title" in value
          && typeof value.title === "string"
          ? { value: value as { title: string } }
          : { issues: [{ message: "Expected a title." }] },
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: {
        output: { schema },
        run: () => ({
          stream: (async function* () {
            yield {
              data: { revision: 1, summary: "Validating the result.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { delta: "{\"title\":\"Validated reply\"}", type: "text-delta" }
            yield { finishReason: "stop", type: "finish" }
          })(),
        }),
      },
      hooks: {
        "agent:finish": event => event.reply((event.result as { title: string }).title),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_016), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.editMessage).toHaveBeenNthCalledWith(1, "telegram:456", "sent-1", { markdown: "Validating the result." })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(2, "telegram:456", "sent-1", { markdown: "Validated reply" })
  })

  it("updates a manual placeholder with progress summaries before the final reply", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            stream: false,
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield {
              data: { revision: 1, summary: "Reviewing the request.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield {
              data: { revision: 2, summary: "Checking current inventory.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { delta: "Private model output", type: "text-delta" }
            yield { finishReason: "stop", type: "finish" }
          })(),
        }),
      },
      hooks: {
        "agent:finish": event => event.reply("Final customer reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_013), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Analyzing photo…")
    expect(adapter.editMessage).toHaveBeenNthCalledWith(1, "telegram:456", "sent-1", { markdown: "Reviewing the request." })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(2, "telegram:456", "sent-1", { markdown: "Checking current inventory." })
    expect(adapter.editMessage).toHaveBeenNthCalledWith(3, "telegram:456", "sent-1", { markdown: "Final customer reply" })
    expect(adapter.postMessage).not.toHaveBeenCalledWith("telegram:456", { markdown: "Private model output" })
  })

  it("does not block manual completion on a hanging progress edit", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let resolveProgressEdit: (() => void) | undefined
    adapter.editMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveProgressEdit = resolve
    }))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield {
              data: { revision: 1, summary: "Reviewing the request.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { finishReason: "stop", type: "finish" }
          })(),
        }),
      },
      hooks: {
        "agent:finish": event => event.reply("Final customer reply"),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_014), "telegram", {
      cloudflare: { env: {} },
      waitUntil: () => undefined,
    })

    expect(response.status).toBe(200)
    expect(adapter.editMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "Final customer reply" })
    resolveProgressEdit?.()
  })

  it("quiesces a hanging progress edit before manual error delivery", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let resolveProgressEdit: (() => void) | undefined
    adapter.editMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveProgressEdit = resolve
    }))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please send the photo again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield {
              data: { revision: 1, summary: "Reviewing the request.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { error: "model timeout", type: "error" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_015), "telegram")).rejects.toThrow("model timeout")
      expect(adapter.editMessage).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", "Please send the photo again.")
      resolveProgressEdit?.()
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("removes a stalled progress placeholder before the Cloudflare timeout fallback", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let resolveProgressEdit: (() => void) | undefined
    adapter.editMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveProgressEdit = resolve
    }))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please send the photo again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            progress: true,
            timeout: 50_000,
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield {
              data: { revision: 1, summary: "Reviewing the request.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            await new Promise(() => undefined)
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_031), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(28_100)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "sent-1")
      expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", "Please send the photo again.")
      expect(adapter.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(adapter.postMessage.mock.invocationCallOrder[1]!)
      resolveProgressEdit?.()
      await vi.runAllTimersAsync()
      expect(adapter.editMessage).toHaveBeenCalledOnce()
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("posts a buffered manual stream when placeholder editing fails", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.editMessage.mockRejectedValueOnce(new Error("edit failed"))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => "Private output" },
      hooks: {
        "agent:finish": event => event.reply((async function* () {
          yield "Streamed "
          yield "reply"
        })()),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_011), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "Streamed reply" })
    expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "sent-1")
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", { markdown: "Streamed reply" })
  })

  it("does not overwrite the first manual reply when a later reply fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockImplementationOnce(async threadId => ({
      id: "sent-1",
      threadId,
    })).mockRejectedValueOnce(new Error("post failed"))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Delivery failed.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => "Private output" },
      hooks: {
        "agent:finish": event => [
          event.reply("First reply"),
          event.reply("Second reply"),
        ],
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_012), "telegram")).rejects.toThrow("post failed")
      expect(adapter.editMessage).toHaveBeenCalledOnce()
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", { markdown: "First reply" })
      expect(adapter.postMessage).toHaveBeenNthCalledWith(3, "telegram:456", "Delivery failed.")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("exposes completed tool results to manual error fallbacks", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let completedToolResults: unknown
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: ({ toolResults }) => {
              completedToolResults = toolResults
              return "Your meal was saved, but the final reply failed."
            },
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { input: { statement: "INSERT INTO meals VALUES (...)" }, toolCallId: "call-1", toolName: "db_exec", type: "tool-call" }
            yield { output: { changes: 1 }, toolCallId: "call-1", toolName: "db_exec", type: "tool-result" }
            yield { error: "model timeout", type: "error" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_035), "telegram")).rejects.toThrow("model timeout")
      expect(completedToolResults).toEqual([{
        output: { changes: 1 },
        toolCallId: "call-1",
        toolName: "db_exec",
      }])
      expect(adapter.editMessage).toHaveBeenCalledWith(
        "telegram:456",
        "sent-1",
        "Your meal was saved, but the final reply failed.",
      )
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it.each([
    ["streamed text", { stream: true }, 91_033],
    ["phased replies", { commentary: "hidden" as const, stream: false }, 91_034],
  ])("exposes completed tool results to automatic %s error fallbacks", async (_delivery, messages, messageId) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let completedToolResults: unknown
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            ...messages,
            errorFallbackText: ({ toolResults }) => {
              completedToolResults = toolResults
              return "Your meal was saved, but the final reply failed."
            },
          },
        }),
      },
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { output: { changes: 1 }, toolCallId: "call-1", toolName: "db_exec", type: "tool-result" }
            yield { error: "model timeout", type: "error" }
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = handler(chatWebhookRequest(messageId), "telegram")
      await expect(response).rejects.toThrow("model timeout")
      expect(completedToolResults).toEqual([{
        output: { changes: 1 },
        toolCallId: "call-1",
        toolName: "db_exec",
      }])
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Your meal was saved, but the final reply failed.")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("replaces a manual placeholder with the error fallback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please send the photo again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => { throw new Error("model timeout") } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_006), "telegram")).rejects.toThrow("model timeout")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Analyzing photo…")
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Please send the photo again.")
      expect(adapter.deleteMessage).not.toHaveBeenCalled()
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("restores manual placeholder ownership when completion cleanup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.deleteMessage.mockRejectedValue(new Error("delete failed"))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please try again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => ({ text: "" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_028), "telegram")).rejects.toThrow("Manual chat delivery could not remove its placeholder.")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("preserves manual placeholder ownership when cleanup fails after the deadline", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.deleteMessage.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 29_000))
      throw new Error("delete failed")
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please try again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            timeout: 50_000,
          },
        }),
      },
      driver: { run: () => ({ text: "" }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_030), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(29_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("bounds provider error details in chat logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const providerError = Object.assign(new Error("Service temporarily unavailable"), {
      requestBodyValues: {
        image: `data:image/jpeg;base64,${"a".repeat(300_000)}`,
      },
      statusCode: 503,
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please try again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => { throw providerError } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = await handler(chatWebhookRequest(91_020), "telegram")
      expect(response.status).toBe(503)
      const logEntry = consoleError.mock.calls[0]?.[0] as { error?: unknown }
      const serializedLogEntry = JSON.stringify(logEntry)
      expect(serializedLogEntry.length).toBeLessThan(20_000)
      expect(serializedLogEntry).not.toContain("data:image/jpeg;base64")
      expect(logEntry.error).toMatchObject({
        message: "Service temporarily unavailable",
        name: "Error",
        statusCode: 503,
      })
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("reserves Cloudflare background time for manual error delivery", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(({ input }) => {
      expect(input.timeout).toBeGreaterThan(27_000)
      expect(input.timeout).toBeLessThanOrEqual(28_000)
      throw new Error("model timeout")
    })
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please try again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_019), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      })).rejects.toThrow("model timeout")
      expect(run).toHaveBeenCalledOnce()
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("delivers the manual fallback when a stream ignores its Cloudflare timeout", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const run = vi.fn(async ({ input }) => {
      expect(input.timeout).toBe(28_000)
      await new Promise(resolve => setTimeout(resolve, 10_000))
      return {
        stream: (async function* () {
          await new Promise(() => undefined)
        })(),
      }
    })
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: "Please try again.",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = handler(chatWebhookRequest(91_021), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledOnce()
      const responseError = response.catch(error => error)

      await vi.advanceTimersByTimeAsync(28_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("delivers the streaming fallback when a stream ignores its Cloudflare timeout", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let invocationAbortSignal: AbortSignal | undefined
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: async () => {
            await new Promise(resolve => setTimeout(resolve, 10_000))
            return adapter as never
          },
          messages: {
            errorFallbackText: "Please try again.",
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: {
        run: async ({ input }) => {
          expect(input.timeout).toBe(18_000)
          invocationAbortSignal = input.abortSignal
          return {
            stream: (async function* () {
              await new Promise(() => undefined)
            })(),
          }
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = handler(chatWebhookRequest(91_022), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      })
      await vi.advanceTimersByTimeAsync(0)
      const responseError = response.catch(error => error)

      await vi.advanceTimersByTimeAsync(28_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(invocationAbortSignal).toMatchObject({
        aborted: true,
        reason: expect.objectContaining({ message: "Chat invocation timed out after 18000ms." }),
      })
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("bounds stalled Cloudflare fallback delivery by the hard deadline", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockImplementation(() => new Promise(() => undefined))
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: "Please try again.",
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: {
        run: async () => ({
          stream: (async function* () {
            await new Promise(() => undefined)
          })(),
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_023), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(29_999)
      await expect(Promise.race([
        responseError.then(() => "settled"),
        Promise.resolve("pending"),
      ])).resolves.toBe("pending")

      await vi.advanceTimersByTimeAsync(1)
      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("rejects queued finish messages before late Cloudflare delivery", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: "Please try again.",
            stream: false,
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: {
        run: async () => {
          await new Promise(resolve => setTimeout(resolve, 30_000))
          return { text: "" }
        },
      },
      hooks: {
        "agent:finish": async (event) => {
          const chat = event.extensions.get("chat") as { sendMessage?: (message: string) => Promise<void> } | undefined
          await chat?.sendMessage?.("late finish message")
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_024), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(28_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Please try again.")

      await vi.advanceTimersByTimeAsync(2_000)
      expect(adapter.postMessage).not.toHaveBeenCalledWith("telegram:456", "late finish message")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("closes stalled finish iterators before timeout fallback delivery", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const reply = {
      [Symbol.asyncIterator]: () => {
        let first = true
        return {
          next: async () => {
            if (first) {
              first = false
              return { done: false as const, value: "partial" }
            }
            return await new Promise<IteratorResult<string>>(() => undefined)
          },
          return: iteratorReturn,
        }
      },
    }
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: "Please try again.",
            stream: false,
            timeout: 50_000,
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run: () => ({ text: "" }) },
      hooks: {
        "agent:finish": async (event) => {
          const chat = event.extensions.get("chat") as { sendMessage?: (message: AsyncIterable<string>) => Promise<void> } | undefined
          await chat?.sendMessage?.(reply)
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_025), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(28_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      expect(iteratorReturn).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledTimes(2)
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Please try again.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("does not duplicate a fallback callback that delivered before timing out", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: async ({ thread }) => {
              await thread.post("Tailored fallback.")
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run: () => { throw new Error("model timeout") } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_026), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(responseError).resolves.toMatchObject({ message: "model timeout" })
      expect(adapter.postMessage).toHaveBeenCalledTimes(1)
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Tailored fallback.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("uses the available Cloudflare deadline to resolve an immediate error fallback", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let resolveFallback: ((fallback: string) => void) | undefined
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: () => new Promise<string>((resolve) => {
              resolveFallback = resolve
            }),
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run: () => { throw new Error("model error") } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const response = handler(chatWebhookRequest(91_032), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      })
      for (let index = 0; index < 100 && !resolveFallback; index++) {
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(resolveFallback).toBeTypeOf("function")
      await vi.advanceTimersByTimeAsync(1_100)
      resolveFallback?.("Tailored fallback.")
      for (let index = 0; index < 20 && !adapter.postMessage.mock.calls.length; index++) await Promise.resolve()
      await expect(response).rejects.toThrow("model error")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Tailored fallback.")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("removes fallback callback delivery that completes after timing out", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    adapter.postMessage.mockImplementation(async (threadId: string, message: unknown) => {
      if (message === "Tailored fallback.") {
        await new Promise(resolve => setTimeout(resolve, 2_000))
        return { id: "late-tailored", raw: { message }, threadId }
      }
      return { id: "default-fallback", raw: { message }, threadId }
    })
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: async ({ thread }) => {
              await thread.post("Tailored fallback.")
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run: () => new Promise(() => undefined) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_029), "telegram", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(28_000)
      await vi.advanceTimersByTimeAsync(1_000)

      await responseError
      expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Sorry, I couldn't process that message.")

      await vi.advanceTimersByTimeAsync(1_000)
      expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "late-tailored")
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("does not post Discord split fragments after the Cloudflare deadline", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { discord } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter() as ReturnType<typeof createTestChatAdapter> & {
      formatConverter: { renderPostable: (message: unknown) => string }
      name: string
    }
    adapter.formatConverter = {
      renderPostable(message: unknown) {
        if (typeof message === "string") return message
        if (typeof message === "object" && message && "raw" in message && typeof message.raw === "string") return message.raw
        if (typeof message === "object" && message && "markdown" in message && typeof message.markdown === "string") return message.markdown
        return ""
      },
    }
    adapter.name = "discord"
    Object.defineProperty(adapter, Symbol.for("vitehub.discord.longContent.mode"), { value: "split" })
    adapter.editMessage.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 29_000))
    })
    const agent = defineAgent({
      channels: {
        discord: discord({
          adapter: () => adapter as never,
          messages: {
            errorFallbackText: "Please try again.",
            stream: true,
            timeout: 50_000,
          },
        }),
      },
      driver: { run: () => ({ text: `${"word ".repeat(430)}done` }) },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      const responseError = handler(chatWebhookRequest(91_027), "discord", {
        cloudflare: { env: {} },
        waitUntil: () => undefined,
      }).catch(error => error)
      await vi.advanceTimersByTimeAsync(28_000)

      await expect(responseError).resolves.toMatchObject({
        message: "Chat invocation timed out after 28000ms.",
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(adapter.postMessage).not.toHaveBeenCalledWith("telegram:456", {
        raw: expect.stringMatching(/ \(2\/2\)$/),
      })
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it("removes a manual placeholder when the error fallback is disabled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            errorFallbackText: null,
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => { throw new Error("model timeout") } },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    try {
      await expect(handler(chatWebhookRequest(91_010), "telegram")).rejects.toThrow("model timeout")
      expect(adapter.postMessage).toHaveBeenCalledOnce()
      expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "sent-1")
      expect(adapter.editMessage).not.toHaveBeenCalled()
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("removes an unused manual placeholder", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => "Private output" },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(chatWebhookRequest(91_007), "telegram")

    expect(response.status).toBe(200)
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:456", "Analyzing photo…")
    expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "sent-1")
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("removes a manual placeholder before posting an artifact reply", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    let finishDelete!: () => void
    adapter.deleteMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishDelete = resolve
    }))
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => "Private output" },
      hooks: {
        async "agent:finish"(event) {
          const chat = event.extensions.get("chat") as { sendMessage?: (message: unknown) => Promise<void> } | undefined
          await chat?.sendMessage?.({
            artifacts: [{
              mediaType: "image/png",
              path: "results/chart.png",
              placement: "inline",
              url: "https://assets.example/results/chart.png",
            }],
            markdown: "See the result.",
          })
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const responsePromise = handler(chatWebhookRequest(91_008), "telegram")

    await vi.waitFor(() => {
      expect(adapter.deleteMessage).toHaveBeenCalledWith("telegram:456", "sent-1")
    })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:456", "Analyzing photo…")
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    finishDelete()

    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(adapter.editMessage).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:456", expect.objectContaining({
      attachments: expect.any(Array),
      markdown: "See the result.",
    }))
  })

  it("fails clearly when an unreplaceable manual reply cannot remove its placeholder", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    ;(adapter as unknown as { deleteMessage?: unknown }).deleteMessage = undefined
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            delivery: "manual",
            fallbackStreamingPlaceholderText: "Analyzing photo…",
          },
        }),
      },
      driver: { run: () => "Private output" },
      hooks: {
        async "agent:finish"(event) {
          const chat = event.extensions.get("chat") as { sendMessage?: (message: unknown) => Promise<void> } | undefined
          await chat?.sendMessage?.({
            artifacts: [{
              mediaType: "image/png",
              path: "results/chart.png",
              placement: "inline",
              url: "https://assets.example/results/chart.png",
            }],
            markdown: "See the result.",
          })
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    await expect(handler(chatWebhookRequest(91_009), "telegram")).rejects.toThrow(
      "Manual chat delivery could not remove its placeholder.",
    )
    expect(adapter.postMessage).toHaveBeenCalledOnce()
    expect(adapter.editMessage).toHaveBeenCalledWith("telegram:456", "sent-1", "Sorry, I couldn't process that message.")
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

  it("derives trigger history from thread history in chat webhook runs", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ persistThreadHistory: true })
    const runs: string[][] = []
    const agent = defineAgent({
      capabilities: [
        defineChatCapability({
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
    const { telegram } = await import("../src/channels.ts")
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
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: {
        run: ({ messages }) => {
          runs.push(messages.map(getMessageText))
          return "ok"
        },
      },
      messages: {
        stream: false,
        triggerHistory: { maxMessages: 10, source: "thread" },
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

  it("does not run id-less chat deliveries without current message parts", async () => {
    const { telegram } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter({ missingIncomingMessageId: true })
    const idLessHistory = (text: string) => new Message({
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
      text,
      threadId: "telegram:456",
    })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        telegram: testTelegram(telegram, { adapter: () => adapter as never }),
      },
      driver: {
        run,
      },
      messages: {
        stream: false,
        triggerHistory: { maxMessages: 10, source: "thread" },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)
    const request = (updateId: number, text?: string) => new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        update_id: updateId,
        message: {
          chat: { id: 456, type: "private" },
          date: 1781092800 + updateId,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          ...(text !== undefined ? { text } : {}),
        },
      }),
      method: "POST",
    })

    adapter.fetchMessages.mockResolvedValueOnce({ messages: [idLessHistory("previous id-less")] })
    await expect(handler(request(23), "telegram")).resolves.toMatchObject({ status: 200 })
    expect(run).not.toHaveBeenCalled()
  })

  it("passes durable thread history into chat webhook runs after adapter cache resets", async () => {
    const { telegram } = await import("../src/channels.ts")
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
        channels: {
          telegram: testTelegram(telegram, { adapter: () => adapter as never }),
        },
        driver: {
          run: ({ messages }) => {
            runs.push(messages.map(getMessageText))
            return `reply ${runs.length}`
          },
        },
        messages: {
          state: () => state,
          stream: false,
          threadHistory: { maxMessages: 25 },
          triggerHistory: { maxMessages: 25, source: "thread" },
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

  it("skips oversized text attachments from durable thread history", async () => {
    const { telegram } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-history-oversized-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const runs: string[][] = []
    try {
      await state.connect?.()
      await state.appendToList("msg-history:telegram:456", new Message({
        attachments: [{
          fetchMetadata: { fileId: "old-log" },
          mimeType: "text/plain",
          name: "old.log",
          size: 8 * 1024 * 1024 + 1,
          type: "file",
        }],
        author: {
          fullName: "Maxi",
          isBot: false,
          isMe: false,
          userId: "123",
          userName: "maxi",
        },
        formatted: { children: [], type: "root" },
        id: "40",
        metadata: { dateSent: new Date("2026-06-10T12:00:00.000Z"), edited: false },
        raw: null,
        text: "old context",
        threadId: "telegram:456",
      }).toJSON(), { maxLength: 25 })
      const adapter = createTestChatAdapter({ persistThreadHistory: true })
      const agent = defineAgent({
        channels: {
          telegram: testTelegram(telegram, { adapter: () => adapter as never }),
        },
        driver: {
          run: ({ messages }) => {
            runs.push(messages.map(getMessageText))
            return "ok"
          },
        },
        messages: {
          state: () => state,
          stream: false,
          threadHistory: { maxMessages: 25 },
          triggerHistory: { maxMessages: 25, source: "thread" },
        },
      })
      const handler = createChannelWebhookRouteHandler(agent as never)

      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 41,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092841,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 41,
            text: "current after large history",
          },
        }),
        method: "POST",
      }), "telegram")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(runs).toEqual([["old context", "current after large history"]])
    }
    finally {
      await state.disconnect?.()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("preserves typed references when durable text attachment URL decoding fails", async () => {
    const { telegram } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { getMessageText } = await import("../src/messages.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("stale attachment"))
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-chat-history-stale-attachment-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const runs: string[][] = []
    let receivedMessages: Array<{ parts: Array<Record<string, unknown>> }> = []
    try {
      await state.connect?.()
      await state.appendToList("msg-history:telegram:456", new Message({
        attachments: [{
          mimeType: "text/plain",
          name: "old.txt",
          size: 12,
          type: "file",
          url: "https://cdn.example/old.txt",
        }],
        author: {
          fullName: "Maxi",
          isBot: false,
          isMe: false,
          userId: "123",
          userName: "maxi",
        },
        formatted: { children: [], type: "root" },
        id: "40",
        metadata: { dateSent: new Date("2026-06-10T12:00:00.000Z"), edited: false },
        raw: null,
        text: "",
        threadId: "telegram:456",
      }).toJSON(), { maxLength: 25 })
      const adapter = createTestChatAdapter({ persistThreadHistory: true })
      const agent = defineAgent({
        channels: {
          telegram: testTelegram(telegram, { adapter: () => adapter as never }),
        },
        driver: {
          run: ({ messages }) => {
            receivedMessages = messages as unknown as Array<{ parts: Array<Record<string, unknown>> }>
            runs.push(messages.map(getMessageText))
            return "ok"
          },
        },
        messages: {
          state: () => state,
          stream: false,
          threadHistory: { maxMessages: 25 },
          triggerHistory: { maxMessages: 25, source: "thread" },
        },
      })
      const handler = createChannelWebhookRouteHandler(agent as never)

      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
        body: JSON.stringify({
          update_id: 42,
          message: {
            chat: { id: 456, type: "private" },
            date: 1781092842,
            from: { first_name: "Maxi", id: 123, username: "maxi" },
            message_id: 42,
            text: "current after stale history",
          },
        }),
        method: "POST",
      }), "telegram")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(fetch).toHaveBeenCalledWith("https://cdn.example/old.txt")
      expect(runs).toEqual([["", "current after stale history"]])
      expect(receivedMessages[0]?.parts).toEqual([
        expect.objectContaining({
          mediaType: "text/plain",
          name: "old.txt",
          type: "file",
          url: "https://cdn.example/old.txt",
        }),
      ])
    }
    finally {
      fetch.mockRestore()
      await state.disconnect?.()
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

  it("lets agent finish hooks post usage for non-streaming model chat webhooks", async () => {
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      const usage = event.invocation.usage
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
    expect(finish.mock.calls[0]![0].invocation.usage).toEqual(expect.objectContaining({
      latency: expect.objectContaining({ durationMs: 900 }),
      model: "openai/gpt-test",
      usage: expect.objectContaining({
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      }),
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

  it("streams event.reply through the Chat SDK transport", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const stream = vi.fn(async (threadId: string, textStream: AsyncIterable<string | StreamChunk>) => {
      let text = ""
      for await (const chunk of textStream) {
        if (typeof chunk === "string") text += chunk
        else if (chunk.type === "markdown_text") text += chunk.text
      }
      return { id: "stream-1", raw: { text }, threadId }
    })
    adapter.stream = stream
    const agent = defineAgent({
      channels: {
        support: testTelegram(telegram, {
          adapter: () => adapter as never,
          messages: {
            stream: false,
          },
        }),
      },
      driver: { run: () => ({ text: "agent answer" }) },
      hooks: {
        "agent:finish"(event) {
          return event.reply((async function* () {
            yield "live "
            yield "transcript"
          })())
        },
      },
    })
    const handler = createChannelWebhookRouteHandler(agent as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/support", {
      body: JSON.stringify({
        update_id: 89,
        message: {
          chat: { id: 889, type: "private" },
          date: 1781092800,
          from: { first_name: "Maxi", id: 123, username: "maxi" },
          message_id: 89,
          text: "hello",
        },
      }),
      method: "POST",
    }), "support")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:889", { markdown: "agent answer" })
    expect(stream).toHaveBeenCalledOnce()
    await expect(stream.mock.results[0]?.value).resolves.toMatchObject({
      raw: { text: "live transcript" },
      threadId: "telegram:889",
    })
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
        support: testTelegram(telegram, {
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
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:988", { markdown: "Preparing assets." })
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:988", { markdown: "agent answer" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
  })

  it("posts finish channel delivery replies after input replacement and rewrites streamed link artifacts", async () => {
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
              payload: (async function* () {
                yield "See [Result report](reports/result.md)."
              })(),
            }))
          },
        }),
      ],
      channels: {
        support: testTelegram(telegram, {
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
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:987", { markdown: "agent answer" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
    expect(adapter.postMessage).toHaveBeenNthCalledWith(2, "telegram:987", {
      markdown: "See [Result report](<https://assets.example/reports/result.md>).",
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
        support: testTelegram(telegram, {
          adapter: () => adapter as never,
        }),
      },
      driver: {
        run: async ({ workspace }) => {
          await (workspace as { fs: { writeFile: (path: string, content: Uint8Array, options?: { mediaType?: string }) => Promise<string> } }).fs.writeFile("screenshots/login.png", content, { mediaType: "image/png" })
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
    expect(adapter.postMessage).toHaveBeenNthCalledWith(1, "telegram:989", { markdown: "agent answer" })
    expect(adapter.editMessage).not.toHaveBeenCalled()
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
    const { github } = await import("../src/channels.ts")
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
      const usage = event.invocation.usage
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
      ],
      channels: { github: github() },
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

  it("lets agent finish hooks compose usage and chat follow-up messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { access } = await import("../src/capabilities.ts")
    const { defineChatCapability } = await import("../src/chat-trigger.ts")
    const { createChannelWebhookRouteHandler } = await import("../src/server/internal.ts")
    const adapter = createTestChatAdapter()
    const finish = vi.fn(async (event) => {
      const chat = event.extensions.get("chat") as { provider?: string, sendMessage?: (message: { markdown: string }) => Promise<void> } | undefined
      const usage = event.invocation.usage
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
    expect(finish.mock.calls[0]![0].invocation.usage).toEqual(expect.objectContaining({
      model: "openai/gpt-test",
      usage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }),
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
  it("loads named Agent Definitions from a registry", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }
    const definition = { resolve: async () => agent } as never

    await expect(getAgentFromRegistry("triager", {
      triager: async () => ({ default: definition }),
    })).resolves.toBe(definition)
  })

  it("throws clearly for unknown named agents", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")

    await expect(getAgentFromRegistry("triage", {
      reviewer: async () => ({} as never),
      triager: async () => ({} as never),
    })).rejects.toThrow("Unknown agent: triage. Did you mean \"triager\"? Discovered agents: reviewer, triager.")
  })
})
