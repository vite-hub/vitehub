import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { createServer } from "vite"

import { hubAgent } from "../src/vite.ts"

interface DeploymentCatalogProof {
  registry: Record<string, () => Promise<{ default?: Record<PropertyKey, unknown> }>>
  state?: { kind: string, options: Record<string, unknown> }
}

const proofKey = "__vitehubAgentDeploymentCatalogProof"

const virtualModules = new Map<string, string>([
  ["@vite-hub/agent", [
    "export function workspaceAgentOwnsWorkspaceDefinition(agent) {",
    "  const workspace = agent?.__vitehubWorkspaceAgentOptions?.workspace",
    "  return workspace && typeof workspace === 'object' && !('name' in workspace)",
    "}",
    "export function workspaceDefinitionFromOptions(options) {",
    "  const { mode, ...workspace } = options.workspace",
    "  return workspace",
    "}",
  ].join("\n")],
  ["@vite-hub/agent/server/internal", [
    `const proof = () => globalThis.${proofKey}`,
    "function assetText(agent, key) {",
    "  const source = agent[Symbol.for('vitehub.agent.colocatedSkills')]?.[key]",
    "  return source ? new TextDecoder().decode(source.content) : undefined",
    "}",
    "function handle(kind, agent, webhook, options) {",
    "  options.waitUntil?.(Promise.resolve(`${agent.description}:${kind}`))",
    "  return Response.json({",
    "    agent: agent.description,",
    "    agentIdentity: options.agentIdentity,",
    "    hasState: options.state === proof().state,",
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
  ].join("\n")],
  ["@vite-hub/agent/state/sqlite", [
    `const proof = globalThis.${proofKey}`,
    "export function createLibsqlAgentState(options) {",
    "  proof.state = { kind: 'sqlite', options }",
    "  return proof.state",
    "}",
  ].join("\n")],
  ["@vite-hub/workspace/runtime", [
    `const proof = globalThis.${proofKey}`,
    "export function setWorkspaceRuntimeRegistry(registry) { proof.registry = registry }",
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

describe("generated Agent deployment catalog", () => {
  it("executes routing, state, wait-until, and Workspace assets through the Nitro module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-deployment-catalog-"))
    const supportRoot = join(root, "server", "agents", "support")
    const reviewerRoot = join(root, "server", "agents", "reviewer")
    const proof: DeploymentCatalogProof = { registry: {} }
    ;(globalThis as typeof globalThis & Record<string, unknown>)[proofKey] = proof

    await mkdir(join(supportRoot, "workspace"), { recursive: true })
    await mkdir(join(supportRoot, "skills", "review"), { recursive: true })
    await mkdir(reviewerRoot, { recursive: true })
    await writeFile(join(supportRoot, "agent.ts"), [
      "const defineAgent = options => options",
      "export default defineAgent({",
      "  description: 'support',",
      "  workspace: {},",
      "  __vitehubWorkspaceAgentOptions: { workspace: { mode: 'write' } },",
      "})",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(supportRoot, "instructions.md"), "Support the deployment catalog.\n", "utf8")
    await writeFile(join(supportRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8")
    await writeFile(join(reviewerRoot, "agent.ts"), [
      "const defineAgent = options => options",
      "export default defineAgent({ description: 'reviewer' })",
      "",
    ].join("\n"), "utf8")

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
        }),
        {
          name: "vitehub-agent-deployment-catalog-proof",
          resolveId(id) {
            return virtualModules.has(id) ? `\0${id}` : undefined
          },
          load(id) {
            return id.startsWith("\0") ? virtualModules.get(id.slice(1)) : undefined
          },
        },
      ],
      root,
      server: { middlewareMode: true },
    })

    try {
      const route = await server.ssrLoadModule(join(root, ".vitehub", "agent", "chat-webhook-route.ts")) as {
        default: (event: Record<string, unknown>) => Promise<Response>
      }
      const runtimeContext: { tasks: Promise<unknown>[], waitUntil: (task: Promise<unknown>) => void } = {
        tasks: [],
        waitUntil(task) {
          this.tasks.push(task)
        },
      }
      const event = (url: string, params: Record<string, string>) => ({
        body: "{}",
        context: runtimeContext,
        headers: { "content-type": "application/json" },
        method: "POST",
        params,
        url,
      })

      const reviewer = await route.default(event(
        "https://example.com/api/_vitehub/agents/reviewer/chat",
        { agent: "reviewer" },
      ))
      const support = await route.default(event(
        "https://example.com/api/_vitehub/agents/support/webhooks/channel",
        { agent: "support", webhook: "channel" },
      ))

      await expect(reviewer.json()).resolves.toMatchObject({
        agent: "reviewer",
        agentIdentity: { name: "reviewer" },
        hasState: false,
        kind: "chat",
        runtime: "vite",
      })
      await expect(support.json()).resolves.toEqual({
        agent: "support",
        agentIdentity: { name: "support", workspace: "support" },
        hasState: true,
        instructions: "Support the deployment catalog.\n",
        kind: "webhook",
        runtime: "vite",
        skill: "# Review\n",
        webhook: "channel",
      })
      await expect(route.default(event(
        "https://example.com/api/_vitehub/agents/missing/chat",
        { agent: "missing" },
      ))).rejects.toMatchObject({
        statusCode: 404,
        statusMessage: "Unknown ViteHub agent.",
      })

      expect(proof.state).toEqual({
        kind: "sqlite",
        options: { tablePrefix: "catalog_", url: "file:catalog.sqlite" },
      })
      expect(runtimeContext.tasks).toHaveLength(2)
      await Promise.all(runtimeContext.tasks)
      expect(Object.keys(proof.registry)).toEqual(["support"])

      const registered = (await proof.registry.support!()).default!
      const registeredSources = registered.sources as Record<string, { content: string }> | undefined
      const registeredSkills = registered[Symbol.for("vitehub.agent.colocatedSkills")] as Record<string, { content: Uint8Array }> | undefined
      expect(registered.sourceRootDir).toBe(join(supportRoot, "workspace"))
      expect(registeredSources?.__vitehubAgentInstructions).toMatchObject({
        content: "Support the deployment catalog.\n",
        materialize: "build",
        workspacePath: "AGENTS.md",
      })
      expect(new TextDecoder().decode(registeredSkills?.["__vitehubAgentSkill:skills/review/SKILL.md"]?.content)).toBe("# Review\n")
    }
    finally {
      await server.close()
      delete (globalThis as typeof globalThis & Record<string, unknown>)[proofKey]
      await rm(root, { force: true, recursive: true })
    }
  })
})
