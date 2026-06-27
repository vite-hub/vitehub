import { describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"

const queueMocks = vi.hoisted(() => ({
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
}))
const envMocks = vi.hoisted(() => ({
  hubEnv: vi.fn(() => ({ name: "@vite-hub/env/vite" })),
}))

vi.mock("@vite-hub/agent", () => Object.fromEntries([
  "agentChatContextKey",
  "agentInvocationStreamRoute",
  "agentInvokerContextKey",
  "appendMessageText",
  "applyAgentToolPolicies",
  "applyStreamEvent",
  "collectStreamEvents",
  "createAgentDevtoolsMetadata",
  "createAgentInvocationStreamResponse",
  "createMessage",
  "defineAgent",
  "defineAgentInvoker",
  "defineCapability",
  "deserializeMessages",
  "getAgent",
  "getAgentChatContext",
  "getAgentFromRegistry",
  "getMessageText",
  "getToolInvocations",
  "isResolvedAgentTriggerHandledInvocation",
  "materializeAgentDevtoolsSourceMetadata",
  "readAgentInvocationStream",
  "resolveAgent",
  "resolveAgentDevtoolsMetadata",
  "resolveAgentTriggerInvocation",
  "resolveAgentTriggers",
  "runAgent",
  "runAgentInline",
  "runAgentTrigger",
  "runScheduledAgent",
  "serializeMessages",
  "streamAgent",
  "streamAgentInline",
  "streamAgentTrigger",
  "validateMessage",
  "verifyAgentWebhookRequest",
  "withAgentDefaults",
  "withAgentToolStepReporting",
  "workflow",
  "workspaceAgentOwnsWorkspaceDefinition",
  "workspaceDefinitionFromOptions",
].map(name => [name, name === "defineAgent" ? "define-agent" : name])))
vi.mock("@vite-hub/agent/capabilities", () => Object.fromEntries([
  "LlmGateRejectedError",
  "RateLimitRejectedError",
  "access",
  "agentChatContextKey",
  "agentScheduleIdFromCron",
  "audioBytes",
  "blob",
  "chat",
  "chatSummary",
  "chatTitle",
  "db",
  "entry",
  "fetch",
  "getAgentChatContext",
  "getTranscriptionResults",
  "git",
  "inputCommands",
  "kv",
  "llmGate",
  "llmRoute",
  "mcp",
  "memory",
  "memoryRateLimitStore",
  "normalizeAgentUsage",
  "observability",
  "openapi",
  "pullRequestContext",
  "rateLimit",
  "repositoryHost",
  "sandbox",
  "schedule",
  "skills",
  "staticModelPricing",
  "subagents",
  "transcribe",
  "usageTelemetry",
  "vercelAiGatewayPricing",
  "webSearch",
  "workspaceExec",
  "workspaceJsonlMemoryStore",
  "workspaceShell",
].map(name => [name, name === "workspaceShell" ? "workspace-shell" : name])))
vi.mock("@vite-hub/agent/channels", () => Object.fromEntries([
  "defineChannel",
  "discord",
  "github",
  "http",
  "publishWorkspaceArtifacts",
  "slack",
  "stream",
  "teams",
  "telegram",
  "webChat",
].map(name => [name, name === "stream" ? "stream-channel" : name])))
vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: () => ({ name: "@vite-hub/blob/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ env: "env-helper", hubEnv: envMocks.hubEnv }))
vi.mock("@vite-hub/kv/vite", () => ({ hubKv: () => ({ name: "@vite-hub/kv/vite" }) }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: queueMocks.hubQueue }))
vi.mock("@vite-hub/sandbox/vite", () => ({ hubSandbox: () => ({ name: "@vite-hub/sandbox/vite" }) }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: () => ({ name: "@vite-hub/schedule/vite" }) }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import type { Plugin, PluginOption } from "vite"
import * as agent from "../src/agent.ts"
import * as capabilities from "../src/agent/capabilities.ts"
import * as channels from "../src/agent/channels.ts"
import { env, vitehub } from "../src/index.ts"

function pluginNames(plugins: PluginOption[]): string[] {
  return plugins.map(plugin => (plugin as Plugin).name)
}

describe("vitehub", () => {
  it("composes ViteHub primitive integrations explicitly", () => {
    expect(pluginNames(vitehub())).toEqual([
      "@vite-hub/vite/facade-alias",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(pluginNames(vitehub({ database: false, devtools: false, kv: false }))).toEqual([
      "@vite-hub/vite/facade-alias",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
    queueMocks.hubQueue.mockClear()
    expect(pluginNames(vitehub({ queue: true }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({})
    expect(pluginNames(vitehub({ queue: { provider: "cloudflare" } }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "cloudflare" })
    expect(pluginNames(vitehub({ env: { prefix: "APP_" } }))).toContain("@vite-hub/env/vite")
    expect(envMocks.hubEnv).toHaveBeenLastCalledWith({
      prefix: "APP_",
      runtimeImports: {
        secret: "@vite-hub/vite/env/secret",
        server: "@vite-hub/vite/env/server",
      },
    })
  })

  it("aliases generated runtime imports through the facade", () => {
    const plugin = vitehub()[0] as Plugin
    const resolveId = plugin.resolveId as unknown as (this: { resolve: ReturnType<typeof vi.fn> }, source: string, importer?: string, options?: Record<string, unknown>) => Promise<unknown>
    const resolve = vi.fn(async (source: string) => ({ id: `/resolved/${source}` }))

    expect(resolveId.call({ resolve }, "@vite-hub/agent/server", "/app/.vitehub/agent/chat.ts", {})).resolves.toEqual({ id: "/resolved/@vite-hub/vite/agent/server" })
    expect(resolveId.call({ resolve }, "@vite-hub/env/server", "/app/.vitehub/env/server.mjs", {})).resolves.toEqual({ id: "/resolved/@vite-hub/vite/env/server" })
    expect(resolveId.call({ resolve }, "@vite-hub/queue", "/app/server/welcome.queue.ts", {})).resolves.toEqual({ id: "/resolved/@vite-hub/vite/queue" })
    expect(resolveId.call({ resolve }, "@vite-hub/workspace/runtime", "/app/.vitehub/workspace/runtime.ts", {})).resolves.toEqual({ id: "/resolved/@vite-hub/vite/workspace/runtime" })
    expect(resolveId.call({ resolve }, "@vite-hub/agent/messages", "/app/server/agent.ts", {})).resolves.toBeUndefined()
    expect(resolveId.call({ resolve }, "@vite-hub/agent", "/app/node_modules/@vite-hub/vite/dist/agent.js", {})).resolves.toBeUndefined()
    expect(resolveId.call({ resolve }, "@vite-hub/env/server", "/repo/packages/vite/dist/env/server.js", {})).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledWith("@vite-hub/vite/agent/server", "/app/.vitehub/agent/chat.ts", { skipSelf: true })

    const configEnvironment = plugin.configEnvironment as (name: string, config: { consumer?: string, resolve?: { noExternal?: unknown } }) => unknown
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { noExternal: ["@vite-hub/vite"] },
    })
    expect(configEnvironment("ssr", { consumer: "server", resolve: { noExternal: ["existing"] } })).toEqual({
      resolve: { noExternal: ["existing", "@vite-hub/vite"] },
    })
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub()]
    expect(plugins).toHaveLength(1)
  })

  it("re-exports the env declaration helper for Vite config", () => {
    expect(env).toBe("env-helper")
  })

  it("forwards the Agent Definition import surface", () => {
    expect(agent.defineAgent).toBe("define-agent")
    expect(capabilities.workspaceShell).toBe("workspace-shell")
    expect(channels.stream).toBe("stream-channel")
  })

  it("emits explicit facade re-exports for generated route imports", async () => {
    await expect(readFile(new URL("../dist/agent.js", import.meta.url), "utf8")).resolves.toContain("withAgentDefaults")
    await expect(readFile(new URL("../dist/agent.js", import.meta.url), "utf8")).resolves.not.toContain("export * from \"@vite-hub/agent\"")
    await expect(readFile(new URL("../dist/agent/server.js", import.meta.url), "utf8")).resolves.toContain("defineAgentChatFetchHandler")
    await expect(readFile(new URL("../dist/agent/runtime/workflow.js", import.meta.url), "utf8")).resolves.toContain("runAgentWorkflowDefinition")
    await expect(readFile(new URL("../dist/queue.js", import.meta.url), "utf8")).resolves.toContain("@vite-hub/queue")
  })
})
