import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
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
  env: env({ default: "typed" }),
  extensions: [
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
  ],
  plugins: vitehub({ preset: "node" }),
  rateLimit: requireRateLimit,
  workflow: defineWorkflow(async ({ payload }: { payload: { marker: string } }) => payload.marker),
  workspace: defineWorkspace({ store: { provider: "memory" } }),
}
