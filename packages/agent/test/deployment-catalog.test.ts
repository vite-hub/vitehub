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
  stateAdapter?: CapturedStateAdapter
  workspaceRegistry: Record<string, () => Promise<{ default?: Record<PropertyKey, unknown> }>>
}

interface DeploymentRuntimeFixture {
  capture: DeploymentRuntimeCapture
  close: () => Promise<void>
  request: (agent: string, route: "chat" | "webhooks/channel") => Promise<Response>
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
      "  const state = typeof options.state === 'function' ? await options.state() : options.state",
      "  options.waitUntil?.(Promise.resolve(`${agent.description}:${kind}`))",
      "  return Response.json({",
      "    agent: agent.description,",
      "    agentIdentity: options.agentIdentity,",
      "    hasState: Boolean(state),",
      "    instructions: agent.sources?.__vitehubAgentInstructions?.content,",
      "    kind,",
      "    runtime: options.runtime,",
      "    skill: assetText(agent, '__vitehubAgentSkill:skills/review/SKILL.md'),",
      "    webhook,",
      "  })",
      "}",
      "export const hasChannelChatRoute = () => true",
      "export const createChannelChatRouteHandler = agent => async (_request, options) => handle('chat', agent, undefined, options)",
      "export const createChannelWebhookRouteHandler = agent => async (_request, webhook, options) => handle('webhook', agent, webhook, options)",
      "export const createDiscordGatewayRouteHandler = agent => async (_request, options) => handle('discord', agent, undefined, options)",
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
      "export const getRouterParam = (event, name) => event.params?.[name]",
      "export const readRawBody = async event => event.body",
    ].join("\n")],
  ])
}

async function createDeploymentRuntimeFixture(adapter: "deno" | "netlify" | "nitro" = "nitro"): Promise<DeploymentRuntimeFixture> {
  const root = await mkdtemp(adapter === "netlify"
    ? join(import.meta.dirname, "fixtures", "deployment-catalog-")
    : join(tmpdir(), "vitehub-agent-deployment-catalog-"))
  const supportRoot = join(root, "server", "agents", "support")
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
    "  driver: { run: async () => ({ text: 'support' }) },",
    "  runtime: false,",
    "  workspace: { mode: 'write' },",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(supportRoot, "instructions.md"), "Support the deployment catalog.\n", "utf8")
  await writeFile(join(supportRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8")
  if (adapter === "nitro") {
    await mkdir(reviewerRoot, { recursive: true })
    await writeFile(join(reviewerRoot, "agent.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "export default defineAgent({",
      "  description: 'reviewer',",
      "  driver: { run: async () => ({ text: 'reviewer' }) },",
      "  runtime: false,",
      "})",
      "",
    ].join("\n"), "utf8")
  }
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
        eval: false,
        providers: {
          state: {
            provider: "sqlite",
            tablePrefix: "catalog_",
            url: "file:catalog.sqlite",
          },
        },
        routes: { chat: true },
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
      alias: [{
        find: /^@vite-hub\/agent$/,
        replacement: join(import.meta.dirname, "..", "src", "index.ts"),
      }],
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

  const route = await server.ssrLoadModule(join(
    root,
    ".vitehub",
    "agent",
    adapter === "deno" ? "deno-server.ts" : adapter === "netlify" ? "netlify-function.mjs" : "chat-webhook-route.ts",
  )) as { default: (input: Record<string, unknown> | Request, context?: Record<string, unknown>) => Promise<Response> }
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
    async request(agent, requestedRoute) {
      const webhook = requestedRoute === "webhooks/channel" ? "channel" : undefined
      if (adapter === "deno") {
        if (!capture.denoHandler) throw new Error("Deno server handler was not registered.")
        return await capture.denoHandler(new Request(`https://example.com/api/_vitehub/agents/${agent}/${requestedRoute}`, {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        }))
      }
      if (adapter === "netlify") {
        return await route.default(
          new Request(`https://example.com/api/_vitehub/agents/${agent}/${requestedRoute}`, {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "POST",
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
        body: "{}",
        context: {
          waitUntil(task: Promise<unknown>) {
            waitUntilTasks.push(task)
          },
        },
        headers: { "content-type": "application/json" },
        method: "POST",
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

    expect(workspace.sourceRootDir).toBe(join(runtime!.supportRoot, "workspace"))
    expect(sources?.__vitehubAgentInstructions).toMatchObject({
      content: "Support the deployment catalog.\n",
      materialize: "build",
      workspacePath: "AGENTS.md",
    })
    expect(new TextDecoder().decode(skills?.["__vitehubAgentSkill:skills/review/SKILL.md"]?.content)).toBe("# Review\n")
    await expect((await runtime!.request("support", "webhooks/channel")).json()).resolves.toMatchObject({
      instructions: "Support the deployment catalog.\n",
      skill: "# Review\n",
    })
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
    expect(Object.keys(runtime.capture.workspaceRegistry)).toEqual(["support"])
    expect(runtime.waitUntilTasks).toHaveLength(2)
  })

  it("executes the same catalog through the Deno Adapter", async () => {
    await runtime!.close()
    runtime = await createDeploymentRuntimeFixture("deno")

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
    expect(await runtime.request("missing", "chat")).toMatchObject({ status: 404 })
    expect(Object.keys(runtime.capture.workspaceRegistry)).toEqual(["support"])
  })
})
