import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
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
import * as authAgent from "vite-hub/auth/agent"
import { resolveBox } from "vite-hub/box"
import { env } from "vite-hub/env"
import * as markdownTemplate from "vite-hub/markdown-template"
import { requireRateLimit } from "vite-hub/rate-limit"
import * as scheduleDriver from "vite-hub/schedule/runtime/driver"
import * as scheduleProcess from "vite-hub/schedule/runtime/process"
import * as cloudflareShell from "vite-hub/shell/providers/cloudflare"
import * as justBashShell from "vite-hub/shell/providers/just-bash"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"
import * as cloudflareWorkspace from "vite-hub/workspace/cloudflare"
import * as workspaceLoader from "vite-hub/workspace/loader"
import * as workspacePublisher from "vite-hub/workspace/publish"
import * as workspaceServer from "vite-hub/workspace/server"

export const contract = {
  agent: defineAgent({
    runtime: false,
    driver: { run: () => ({ text: "typed" }) },
  }),
  builtInAgent: defineAgent({ driver: "codex", runtime: false }),
  box: resolveBox({ runtime: "trusted-host" }, {}),
  env: env({ default: "typed" }),
  extensions: [
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
  ],
  plugins: vitehub({
    email: {
      driver: "resend",
      options: {
        apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      },
    },
    preset: "node",
  }),
  rateLimit: requireRateLimit,
  workflow: defineWorkflow(async ({ payload }: { payload: { marker: string } }) => payload.marker),
  workspace: defineWorkspace({ store: { provider: "memory" } }),
}

export const builtInAgentName = "codex" satisfies BuiltInAgentDriverName
export const configuredCodex = { kind: "codex", permissions: "ask" } satisfies BuiltInAgentDriver
export const codexOptions = { model: "gpt-5.5" } satisfies CodexDriverOptions
export const claudeCodeOptions = { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } satisfies ClaudeCodeDriverOptions
