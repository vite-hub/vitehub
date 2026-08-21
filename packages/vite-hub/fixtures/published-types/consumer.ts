import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { defineAgent, otlpHttpJson } from "vite-hub/agent"
import type {
  BuiltInAgentDriver,
  BuiltInAgentDriverName,
  ClaudeCodeDriverOptions,
  CodexDriverOptions,
} from "vite-hub/agent"
import * as agentCloudflare from "vite-hub/agent/cloudflare"
import * as agentEval from "vite-hub/agent/eval"
import * as agentServer from "vite-hub/agent/server"
import * as agentSqliteState from "vite-hub/agent/state/sqlite"
import { useAgent, useChat } from "vite-hub/agent/vue"
import * as authAgent from "vite-hub/auth/agent"
import { createAuthClient, useUserSession } from "vite-hub/auth/vue"
import type { BoxDefinition } from "vite-hub/box"
import { env } from "vite-hub/env"
import * as markdownTemplate from "vite-hub/markdown-template"
import viteHubNuxtModule from "vite-hub/nuxt"
import * as scheduleDriver from "vite-hub/schedule/runtime/driver"
import * as scheduleProcess from "vite-hub/schedule/runtime/process"
import * as cloudflareShell from "vite-hub/shell/providers/cloudflare"
import * as justBashShell from "vite-hub/shell/providers/just-bash"
import * as cloudflareWorkspace from "vite-hub/workspace/cloudflare"
import * as workspaceLoader from "vite-hub/workspace/loader"
import * as workspacePublisher from "vite-hub/workspace/publish"
import * as workspaceServer from "vite-hub/workspace/server"

export const appFacingModules = [
  agentCloudflare,
  agentEval,
  agentServer,
  agentSqliteState,
  authAgent,
  markdownTemplate,
  scheduleDriver,
  scheduleProcess,
  cloudflareShell,
  justBashShell,
  cloudflareWorkspace,
  workspaceLoader,
  workspacePublisher,
  workspaceServer,
]

export const nuxtModule = viteHubNuxtModule
export const customAuthClient = createAuthClient({ basePath: "/auth" })
export const userSession = useUserSession(customAuthClient)
export const supportChat = useChat(useAgent("support"))
export const builtInAgent = defineAgent({
  driver: "codex",
  runtime: false,
  telemetry: otlpHttpJson({ endpoint: "https://console.example/v1/traces" }),
})
export const builtInBox = { runtime: "trusted-host" } satisfies BoxDefinition
export const builtInAgentName = "codex" satisfies BuiltInAgentDriverName
export const configuredCodex = { kind: "codex", permissions: "ask" } satisfies BuiltInAgentDriver
export const codexOptions = { model: "gpt-5.5" } satisfies CodexDriverOptions
export const claudeCodeOptions = { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } satisfies ClaudeCodeDriverOptions

export default defineConfig({
  env: {
    server: {
      GH_TOKEN: env(),
    },
  },
  plugins: [vitehub({
    name: "published-consumer",
    preset: "node",
    agent: true,
    blob: true,
    database: true,
    workflow: true,
    workspace: true,
  })],
})
