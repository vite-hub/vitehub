import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { hubAgent } from "../src/vite.ts"

interface CapturedStateAdapter {
  kind: string
  options: Record<string, unknown>
}

interface DeploymentRuntimeCapture {
  denoHandler?: (request: Request) => Promise<Response>
  lastAgent?: Record<PropertyKey, unknown>
  registeredAgent?: Record<PropertyKey, unknown>
  registeredWorkspaceName?: string
  stateAdapter?: CapturedStateAdapter
  workspaceRegistry: Record<string, () => Promise<{ default?: Record<PropertyKey, unknown> }>>
}

interface DeploymentRuntimeFixture {
  capture: DeploymentRuntimeCapture
  close: () => Promise<void>
  request: (agent: string, route: "chat" | "inspection" | "webhooks/channel", method?: string) => Promise<Response>
  supportRoot: string
  waitUntilTasks: Promise<unknown>[]
  workspace: (name: string) => Promise<Record<PropertyKey, unknown>>
}

const runtimeCaptureKey = "__vitehubAgentDeploymentRuntimeCapture"

function deploymentRuntimeModules(): Map<string, string> {
  return new Map([
    ["@vite-hub/agent/server/internal", [
      `const capture = () => globalThis.${runtimeCaptureKey}`,
      "function assetText(agent, key) {",
      "  const source = agent[Symbol.for('vitehub.agent.colocatedSkills')]?.[key]",
      "  return source ? new TextDecoder().decode(source.content) : undefined",
      "}",
      "async function handle(kind, agent, webhook, options) {",
      "  capture().lastAgent = agent",
      "  const state = typeof options.state === 'function' ? await options.state() : options.state",
      "  options.waitUntil?.(Promise.resolve(`${agent.description}:${kind}`))",
      "  return Response.json({",
      "    agent: agent.description,",
      "    agentIdentity: options.agentIdentity,",
      "    driverInstructions: agent.__vitehubAgentSettings?.driver?.instructions,",
      "    hasState: Boolean(state),",
      "    instructions: agent.sources?.__vitehubAgentInstructions?.content,",
      "    kind,",
      "    runtime: options.runtime,",
      "    skill: assetText(agent, '__vitehubAgentSkill:skills/review/SKILL.md'),",
      "    webhook,",
      "  })",
      "}",
      "export const createAgentWebhookRequest = input => new Request(input.url, input)",
      "export const hasChannelChatRoute = () => true",
      "export const createChannelChatRouteHandler = agent => async (_request, options) => handle('chat', agent, undefined, options)",
      "export const createChannelWebhookRouteHandler = agent => async (_request, webhook, options) => handle('webhook', agent, webhook, options)",
      "export const createDiscordGatewayRouteHandler = agent => async (_request, options) => handle('discord', agent, undefined, options)",
      "export function markDiscoveredWorkspaceAgentDefinitionRegistered(agent, defaults) {",
      "  const name = agent.__vitehubWorkspaceAgentOptions?.name || defaults.workspace || defaults.name",
      "  capture().registeredAgent = agent",
      "  capture().registeredWorkspaceName = name",
      "  return name",
      "}",
    ].join("\n")],
    ["@vite-hub/agent/state/sqlite", [
      `const capture = globalThis.${runtimeCaptureKey}`,
      "export function createLibsqlAgentState(options) {",
      "  capture.stateAdapter = { kind: 'sqlite', options }",
      "  return capture.stateAdapter",
      "}",
    ].join("\n")],
    ["@vite-hub/workspace/runtime", [
      `const capture = globalThis.${runtimeCaptureKey}`,
      "export function setWorkspaceRuntimeRegistry(workspaceRegistry) { capture.workspaceRegistry = workspaceRegistry }",
    ].join("\n")],
    ["@vite-hub/agent/server/workspace", [
      `const capture = globalThis.${runtimeCaptureKey}`,
      "export function setWorkspaceRuntimeRegistry(workspaceRegistry) { capture.workspaceRegistry = workspaceRegistry }",
    ].join("\n")],
    ["@vite-hub/workspace/internal/runtime/hosted", "export function installHostedWorkspaceRuntime() {}"],
    ["@vite-hub/workspace/internal/runtime/hosted-vercel-blob", "export function installHostedVercelBlobWorkspaceRuntime() {}"],
    ["h3", [
      "export const createError = input => Object.assign(new Error(input.statusMessage), input)",
      "export const defineEventHandler = handler => handler",
      "export const getRequestHeaders = event => event.headers || {}",
      "export const getRequestURL = event => new URL(event.url)",
      "export const getRequestWebStream = event => event.body",
      "export const getRouterParam = (event, name) => event.params?.[name]",
    ].join("\n")],
  ])
}

async function createDeploymentRuntimeFixture(
  adapter: "deno" | "netlify" | "nitro" = "nitro",
  supportName = "support",
  inspectionRoute: true | string = true,
  discordGatewayRoute?: true | string,
  declaredWorkspaceName?: string,
): Promise<DeploymentRuntimeFixture> {
  const root = await mkdtemp(adapter === "netlify"
    ? join(import.meta.dirname, "fixtures", "deployment-catalog-")
    : join(tmpdir(), "vitehub-agent-deployment-catalog-"))
  const supportRoot = join(root, "server", "agents", ...supportName.split("/"))
  const reviewerRoot = join(root, "server", "agents", "reviewer")
  const capture: DeploymentRuntimeCapture = { workspaceRegistry: {} }
  const scope = globalThis as typeof globalThis & Record<string, unknown>
  const previousDeno = scope.Deno
  scope[runtimeCaptureKey] = capture

  await mkdir(join(supportRoot, "workspace"), { recursive: true })
  await mkdir(join(supportRoot, "skills", "review"), { recursive: true })
  await writeFile(join(supportRoot, "agent.ts"), [
    "import { defineAgent } from '@vite-hub/agent'",
    "export default defineAgent({",
    "  description: 'support',",
    "  driver: { model: {} },",
    ...(declaredWorkspaceName ? [`  name: ${JSON.stringify(declaredWorkspaceName)},`] : []),
    "  runtime: false,",
    "  workspace: { mode: 'write' },",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(supportRoot, "instructions.md"), "Support the deployment catalog.\n", "utf8")
  await writeFile(join(supportRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8")
  await mkdir(reviewerRoot, { recursive: true })
  await writeFile(join(reviewerRoot, "agent.ts"), [
    "import { defineAgent, defineCapability } from '@vite-hub/agent'",
    "export default defineAgent({",
    "  capabilities: ({ abortSignal, actor, agentIdentity, event, request, runtime, waitUntil }) => actor.kind === 'inspection' ? [defineCapability({",
    "    id: 'runtime',",
    "    metadata: { actor: actor.kind, agent: agentIdentity?.name, hasAbortSignal: Boolean(abortSignal), hasEvent: Boolean(event), hasWaitUntil: typeof waitUntil === 'function', method: request?.method, runtime, token: 'private' },",
    "  })] : [],",
    "  description: 'reviewer',",
    "  driver: { model: {} },",
    "  runtime: false,",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(reviewerRoot, "instructions.md"), "Review the deployment catalog.\n", "utf8")
  const brokenRoot = join(root, "server", "agents", "broken")
  await mkdir(brokenRoot, { recursive: true })
  await writeFile(join(brokenRoot, "agent.ts"), [
    "import { defineAgent } from '@vite-hub/agent'",
    "export default defineAgent({",
    "  capabilities: ({ actor }) => { if (actor.kind === 'inspection') throw new Error('private failure') ; return [] },",
    "  description: 'broken',",
    "  driver: { run: () => 'ok' },",
    "  runtime: false,",
    "})",
    "",
  ].join("\n"), "utf8")
  if (adapter === "deno") {
    await mkdir(join(root, ".vitehub", "schedule"), { recursive: true })
    await writeFile(join(root, ".vitehub", "schedule", "deno-cron.mjs"), "", "utf8")
  }

  const modules = deploymentRuntimeModules()
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [
      hubAgent({
        providers: {
          state: {
            provider: "sqlite",
            tablePrefix: "catalog_",
            url: "file:catalog.sqlite",
          },
        },
        routes: { discordGateway: discordGatewayRoute, inspection: inspectionRoute },
        ...(adapter === "deno" ? { runtime: "deno" } : {}),
      }),
      {
        enforce: "pre",
        name: "vitehub-agent-deployment-runtime-fixture",
        resolveId(id) {
          return modules.has(id) ? `\0${id}` : undefined
        },
        load(id) {
          return id.startsWith("\0") ? modules.get(id.slice(1)) : undefined
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: /^@vite-hub\/agent\/runtime\/workflow$/,
          replacement: join(import.meta.dirname, "..", "src", "runtime", "workflow.ts"),
        },
        {
          find: /^@vite-hub\/agent$/,
          replacement: join(import.meta.dirname, "..", "src", "index.ts"),
        },
      ],
    },
    root,
    server: { middlewareMode: true },
  })

  if (adapter === "deno") {
    scope.Deno = {
      args: [],
      serve(...args: unknown[]) {
        capture.denoHandler = args.at(-1) as (request: Request) => Promise<Response>
      },
    }
  }

  let route: { default: (input: Record<string, unknown> | Request, context?: Record<string, unknown>) => Promise<Response> }
  try {
    route = await server.ssrLoadModule(join(
      root,
      ".vitehub",
      "agent",
      adapter === "deno" ? "deno-server.ts" : adapter === "netlify" ? "netlify-function.mjs" : "chat-webhook-route.ts",
    )) as typeof route
  }
  catch (error) {
    await server.close()
    delete scope[runtimeCaptureKey]
    await rm(root, { force: true, recursive: true })
    throw error
  }
  const waitUntilTasks: Promise<unknown>[] = []

  return {
    capture,
    supportRoot,
    waitUntilTasks,
    async close() {
      await server.close()
      delete scope[runtimeCaptureKey]
      if (adapter === "deno") {
        if (previousDeno === undefined) delete scope.Deno
        else scope.Deno = previousDeno
      }
      await rm(root, { force: true, recursive: true })
    },
    async request(agent, requestedRoute, method = requestedRoute === "inspection" ? "GET" : "POST") {
      const webhook = requestedRoute === "webhooks/channel" ? "channel" : undefined
      const body = method === "GET" || method === "HEAD" ? undefined : "{}"
      if (adapter === "deno") {
        if (!capture.denoHandler) throw new Error("Deno server handler was not registered.")
        return await capture.denoHandler(new Request(`https://example.com/api/_vitehub/agents/${agent}/${requestedRoute}`, {
          ...(body ? { body } : {}),
          headers: { "content-type": "application/json" },
          method,
        }))
      }
      if (adapter === "netlify") {
        return await route.default(
          new Request(`https://example.com/api/_vitehub/agents/${agent}/${requestedRoute}`, {
            ...(body ? { body } : {}),
            headers: { "content-type": "application/json" },
            method,
          }),
          {
            params: { agent, ...(webhook ? { webhook } : {}) },
            waitUntil(task: Promise<unknown>) {
              waitUntilTasks.push(task)
            },
          },
        )
      }
      return await route.default({
        body,
        context: {
          waitUntil(task: Promise<unknown>) {
            waitUntilTasks.push(task)
          },
        },
        headers: { "content-type": "application/json" },
        method,
        params: { agent, ...(webhook ? { webhook } : {}) },
        url: `https://example.com/api/_vitehub/agents/${agent}/${requestedRoute}`,
      })
    },
    async workspace(name) {
      const load = capture.workspaceRegistry[name]
      if (!load) throw new Error(`Workspace ${name} was not registered.`)
      const workspace = (await load()).default
      if (!workspace) throw new Error(`Workspace ${name} has no default definition.`)
      return workspace
    },
  }
}

describe("generated Agent deployment catalog", () => {
  let runtime: DeploymentRuntimeFixture | undefined

  beforeEach(async () => {
    vi.stubEnv("VITEHUB_AGENT_STATE_AUTH_TOKEN", "")
    vi.stubEnv("VITEHUB_AGENT_STATE_URL", "")
    runtime = await createDeploymentRuntimeFixture()
  })

  afterEach(async () => {
    await runtime?.close()
    runtime = undefined
    vi.unstubAllEnvs()
  })

  it("routes chat and webhook requests and rejects unknown Agents", async () => {
    await expect((await runtime!.request("reviewer", "chat")).json()).resolves.toMatchObject({
      agent: "reviewer",
      agentIdentity: { name: "reviewer" },
      driverInstructions: "Review the deployment catalog.\n",
      kind: "chat",
      runtime: "vite",
    })
    await expect((await runtime!.request("support", "webhooks/channel")).json()).resolves.toMatchObject({
      agent: "support",
      agentIdentity: { name: "support", workspace: "support" },
      kind: "webhook",
      runtime: "vite",
      webhook: "channel",
    })
    await expect(runtime!.request("missing", "chat")).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: "Unknown ViteHub agent.",
    })
  })

  it("serves canonical inspection metadata with private error responses", async () => {
    const response = await runtime!.request("reviewer", "inspection")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({
      capabilities: [{
        id: "runtime",
        metadata: {
          actor: "inspection",
          agent: "reviewer",
          hasAbortSignal: true,
          hasEvent: true,
          hasWaitUntil: true,
          method: "GET",
          runtime: "vite",
          token: "[redacted]",
        },
      }],
      name: "reviewer",
    })

    const method = await runtime!.request("reviewer", "inspection", "POST")
    expect(method.status).toBe(405)
    expect(method.headers.get("cache-control")).toBe("private, no-store")

    const missing = await runtime!.request("missing", "inspection")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("cache-control")).toBe("private, no-store")

    const broken = await runtime!.request("broken", "inspection")
    expect(broken.status).toBe(500)
    expect(await broken.json()).toEqual({ message: "Agent inspection failed.", status: 500 })
  })

  it("rejects inspection routes without an Agent parameter for multi-Agent deployments", async () => {
    await runtime!.close()
    runtime = undefined

    await expect(createDeploymentRuntimeFixture("nitro", "support", "/internal/status"))
      .rejects.toThrow("Multi-Agent inspection routes require an agent route parameter.")

    await expect(createDeploymentRuntimeFixture("nitro", "support", "/internal/not[agent]"))
      .rejects.toThrow("Multi-Agent inspection routes require an agent route parameter.")

    runtime = await createDeploymentRuntimeFixture("nitro", "support", "/internal/agents/:agent/inspection")
  })

  it("rejects inspection routes that overlap generated routes", async () => {
    await runtime!.close()
    runtime = undefined

    for (const route of [
      "/api/_vitehub/agents/[agent]/chat",
      "/api/_vitehub/agents/[agent]/webhooks/custom",
    ]) {
      await expect(createDeploymentRuntimeFixture("nitro", "support", route))
        .rejects.toThrow("Agent inspection route conflicts with the generated route")
    }
    await expect(createDeploymentRuntimeFixture(
      "nitro",
      "support",
      "/api/_vitehub/agents/[agent]/discord/gateway",
      true,
    )).rejects.toThrow("Agent inspection route conflicts with the generated route")

    runtime = await createDeploymentRuntimeFixture()
  })

  it("passes the configured state adapter and waitUntil to route handlers", async () => {
    await expect((await runtime!.request("reviewer", "chat")).json()).resolves.toMatchObject({ hasState: false })
    await expect((await runtime!.request("support", "webhooks/channel")).json()).resolves.toMatchObject({ hasState: true })
    expect(runtime!.capture.stateAdapter).toEqual({
      kind: "sqlite",
      options: { tablePrefix: "catalog_", url: "file:catalog.sqlite" },
    })
    expect(runtime!.waitUntilTasks).toHaveLength(2)
    await expect(Promise.all(runtime!.waitUntilTasks)).resolves.toEqual(["reviewer:chat", "support:webhook"])
  })

  it("registers the Workspace definition with colocated instructions and skills", async () => {
    expect(Object.keys(runtime!.capture.workspaceRegistry)).toEqual(["support"])
    const workspace = await runtime!.workspace("support")
    const sources = workspace.sources as Record<string, { content: string }> | undefined
    const skills = workspace[Symbol.for("vitehub.agent.colocatedSkills")] as Record<string, { content: Uint8Array }> | undefined
    const settings = Object.getOwnPropertyDescriptor(workspace, "__vitehubAgentSettings")?.value as {
      driver?: { instructions?: unknown }
    } | undefined

    expect(workspace.sourceRootDir).toBe(join(runtime!.supportRoot, "workspace"))
    expect(sources?.__vitehubAgentInstructions).toMatchObject({
      content: "Support the deployment catalog.\n",
      materialize: "build",
      workspacePath: "AGENTS.md",
    })
    expect(new TextDecoder().decode(skills?.["__vitehubAgentSkill:skills/review/SKILL.md"]?.content)).toBe("# Review\n")
    expect(settings?.driver?.instructions).toBeUndefined()
    await expect((await runtime!.request("support", "webhooks/channel")).json()).resolves.toMatchObject({
      instructions: "Support the deployment catalog.\n",
      skill: "# Review\n",
    })
    expect(runtime!.capture.lastAgent).toBe(runtime!.capture.registeredAgent)
    expect(runtime!.capture.registeredWorkspaceName).toBe("support")
  })

  it("registers an explicitly named production Agent under its resolved Workspace name", async () => {
    await runtime!.close()
    runtime = await createDeploymentRuntimeFixture("nitro", "support", true, undefined, "support-workspace")

    expect(Object.keys(runtime.capture.workspaceRegistry)).toEqual(["support-workspace"])
    await runtime.request("support", "webhooks/channel")
    expect(runtime.capture.lastAgent).toBe(runtime.capture.registeredAgent)
    expect(runtime.capture.registeredWorkspaceName).toBe("support-workspace")
    await expect(runtime.workspace("support-workspace")).resolves.toBeDefined()
  })

  it("executes the same catalog through the Netlify Adapter", async () => {
    await runtime!.close()
    vi.stubEnv("VITEHUB_HOSTING", "netlify")
    runtime = await createDeploymentRuntimeFixture("netlify")

    await expect((await runtime.request("support", "chat")).json()).resolves.toMatchObject({
      agent: "support",
      agentIdentity: { name: "support", workspace: "support" },
      kind: "chat",
    })
    await expect((await runtime.request("support", "webhooks/channel")).json()).resolves.toMatchObject({
      agent: "support",
      agentIdentity: { name: "support", workspace: "support" },
      kind: "webhook",
      webhook: "channel",
    })
    await expect((await runtime.request("reviewer", "inspection")).json()).resolves.toMatchObject({
      capabilities: [{ id: "runtime", metadata: { hasEvent: true, runtime: "vite", token: "[redacted]" } }],
      name: "reviewer",
    })
    expect(Object.keys(runtime.capture.workspaceRegistry)).toEqual(["support"])
    expect(runtime.waitUntilTasks).toHaveLength(2)
  })

  it("executes the same catalog through the Deno Adapter", async () => {
    await runtime!.close()
    runtime = await createDeploymentRuntimeFixture("deno", "team/support")

    await expect((await runtime.request("team%2Fsupport", "chat")).json()).resolves.toMatchObject({
      agent: "support",
      agentIdentity: { name: "team/support", workspace: "team/support" },
      kind: "chat",
    })
    await expect((await runtime.request("team%2Fsupport", "webhooks/channel")).json()).resolves.toMatchObject({
      agent: "support",
      agentIdentity: { name: "team/support", workspace: "team/support" },
      kind: "webhook",
      webhook: "channel",
    })
    await expect((await runtime.request("reviewer", "inspection")).json()).resolves.toMatchObject({
      capabilities: [{ id: "runtime", metadata: { runtime: "deno", token: "[redacted]" } }],
      name: "reviewer",
    })
    expect(await runtime.request("missing", "chat")).toMatchObject({ status: 404 })
    expect(Object.keys(runtime.capture.workspaceRegistry)).toEqual(["team/support"])
  })
})
