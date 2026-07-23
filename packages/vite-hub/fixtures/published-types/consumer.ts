import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import * as agentCloudflare from "vite-hub/agent/cloudflare"
import * as agentEval from "vite-hub/agent/eval"
import * as claudeCodeHarness from "vite-hub/agent/harness/claude-code"
import * as codexHarness from "vite-hub/agent/harness/codex"
import * as localHarnessSandbox from "vite-hub/agent/harness/local-sandbox"
import * as agentServer from "vite-hub/agent/server"
import * as agentSqliteState from "vite-hub/agent/state/sqlite"
import * as authAgent from "vite-hub/auth/agent"
import * as crabbox from "vite-hub/box/crabbox"
import * as smtp from "vite-hub/email/drivers/smtp"
import { env } from "vite-hub/env"
import * as markdownTemplate from "vite-hub/markdown-template"
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
  claudeCodeHarness,
  codexHarness,
  localHarnessSandbox,
  agentServer,
  agentSqliteState,
  authAgent,
  crabbox,
  smtp,
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
