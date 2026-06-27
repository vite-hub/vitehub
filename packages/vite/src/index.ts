import { hubAgent } from "@vite-hub/agent/vite"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubDb } from "@vite-hub/database/vite"
import { hubDevtools } from "@vite-hub/devtools"
import { hubEnv } from "@vite-hub/env/vite"
import { hubKv } from "@vite-hub/kv/vite"
import { hubQueue } from "@vite-hub/queue/vite"
import { hubSandbox } from "@vite-hub/sandbox/vite"
import { hubSchedule } from "@vite-hub/schedule/vite"
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"

import type { AgentModuleOptions } from "@vite-hub/agent"
import type { BlobModuleOptions } from "@vite-hub/blob"
import type { DBModulePublicOptions } from "@vite-hub/database"
import type { HubDevtoolsOptions } from "@vite-hub/devtools"
import type { EnvIntegrationOptions } from "@vite-hub/env"
import type { KVModuleOptions } from "@vite-hub/kv"
import type { QueueModuleOptions } from "@vite-hub/queue"
import type { SandboxPublicOptions } from "@vite-hub/sandbox/vite"
import type { ScheduleVitePluginOptions } from "@vite-hub/schedule/vite"
import type { WorkflowModuleOptions } from "@vite-hub/workflow"
import type { WorkspaceModuleOptions } from "@vite-hub/workspace"
import type { Plugin, PluginOption } from "vite"

export { env } from "@vite-hub/env/vite"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined

const presetScheduleStaticRuntimeImport = "@vite-hub/vite/schedule/runtime/static"
const presetAgentImportBase = "@vite-hub/vite/agent"
const presetWorkspaceImportBase = "@vite-hub/vite/workspace"

const facadeAliases: Record<string, string> = {
  "@vite-hub/agent": "@vite-hub/vite/agent",
  "@vite-hub/agent/capabilities": "@vite-hub/vite/agent/capabilities",
  "@vite-hub/agent/channels": "@vite-hub/vite/agent/channels",
  "@vite-hub/agent/cloudflare": "@vite-hub/vite/agent/cloudflare",
  "@vite-hub/agent/cloudflare/state": "@vite-hub/vite/agent/cloudflare/state",
  "@vite-hub/agent/eval": "@vite-hub/vite/agent/eval",
  "@vite-hub/agent/harness/local-sandbox": "@vite-hub/vite/agent/harness/local-sandbox",
  "@vite-hub/agent/mcp": "@vite-hub/vite/agent/mcp",
  "@vite-hub/agent/mcp/stdio": "@vite-hub/vite/agent/mcp/stdio",
  "@vite-hub/agent/runtime/workflow": "@vite-hub/vite/agent/runtime/workflow",
  "@vite-hub/agent/server": "@vite-hub/vite/agent/server",
  "@vite-hub/agent/server/workspace": "@vite-hub/vite/agent/server/workspace",
  "@vite-hub/agent/state/sqlite": "@vite-hub/vite/agent/state/sqlite",
  "@vite-hub/blob": "@vite-hub/vite/blob",
  "@vite-hub/blob/ensure": "@vite-hub/vite/blob/ensure",
  "@vite-hub/blob/storage": "@vite-hub/vite/blob/storage",
  "@vite-hub/database": "@vite-hub/vite/database",
  "@vite-hub/database/drizzle": "@vite-hub/vite/database/drizzle",
  "@vite-hub/env": "@vite-hub/vite/env",
  "@vite-hub/env/secret": "@vite-hub/vite/env/secret",
  "@vite-hub/env/server": "@vite-hub/vite/env/server",
  "@vite-hub/env/vite": "@vite-hub/vite/env/vite",
  "@vite-hub/kv": "@vite-hub/vite/kv",
  "@vite-hub/queue": "@vite-hub/vite/queue",
  "@vite-hub/sandbox": "@vite-hub/vite/sandbox",
  "@vite-hub/sandbox/runtime/provider-loader": "@vite-hub/vite/sandbox/runtime/provider-loader",
  "@vite-hub/sandbox/runtime/state": "@vite-hub/vite/sandbox/runtime/state",
  "@vite-hub/schedule": "@vite-hub/vite/schedule",
  "@vite-hub/schedule/runtime": "@vite-hub/vite/schedule/runtime",
  "@vite-hub/schedule/runtime/state": "@vite-hub/vite/schedule/runtime/state",
  "@vite-hub/schedule/runtime/static": "@vite-hub/vite/schedule/runtime/static",
  "@vite-hub/workflow": "@vite-hub/vite/workflow",
  "@vite-hub/workflow/runtime/execute": "@vite-hub/vite/workflow/runtime/execute",
  "@vite-hub/workflow/runtime/state": "@vite-hub/vite/workflow/runtime/state",
  "@vite-hub/workspace": "@vite-hub/vite/workspace",
  "@vite-hub/workspace/cloudflare": "@vite-hub/vite/workspace/cloudflare",
  "@vite-hub/workspace/loader": "@vite-hub/vite/workspace/loader",
  "@vite-hub/workspace/publish": "@vite-hub/vite/workspace/publish",
  "@vite-hub/workspace/runtime": "@vite-hub/vite/workspace/runtime",
  "@vite-hub/workspace/server": "@vite-hub/vite/workspace/server",
}

function mergeNoExternal(current: NoExternalValue): NoExternalValue {
  if (current === true) return true
  if (!current) return ["@vite-hub/vite"]
  const values = Array.isArray(current) ? current : [current]
  return values.includes("@vite-hub/vite") ? values : [...values, "@vite-hub/vite"]
}

function isFacadeImporter(importer: string | undefined): boolean {
  if (!importer) return false
  const normalized = importer.replace(/\\/g, "/")
  return /(?:^|\/)(?:packages\/vite\/src|packages\/vite\/dist|@vite-hub\/vite\/dist)\//.test(normalized)
}

function vitehubFacadeAlias(): Plugin {
  return {
    name: "@vite-hub/vite/facade-alias",
    enforce: "pre",
    configEnvironment(name, config) {
      if (name !== "ssr" && config.consumer !== "server") return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    async resolveId(id, importer, options) {
      const facadeId = facadeAliases[id] ?? id.replace(/^@vite-hub\/blob\/drivers\//, "@vite-hub/vite/blob/drivers/")
      if (!facadeId || isFacadeImporter(importer)) return
      if (facadeId === id) return
      return await this.resolve(facadeId, importer, { ...options, skipSelf: true })
    },
  }
}

export interface ViteHubPresetOptions {
  agent?: false | AgentModuleOptions
  blob?: false | BlobModuleOptions
  database?: false | DBModulePublicOptions
  devtools?: false | HubDevtoolsOptions
  env?: false | EnvIntegrationOptions
  kv?: false | KVModuleOptions
  queue?: boolean | QueueModuleOptions
  sandbox?: false | SandboxPublicOptions
  schedule?: false | ScheduleVitePluginOptions
  workflow?: false | WorkflowModuleOptions
  workspace?: false | WorkspaceModuleOptions
}

export function vitehub(options: ViteHubPresetOptions = {}): PluginOption[] {
  const plugins: unknown[] = [vitehubFacadeAlias()]
  if (options.env !== false) plugins.push(hubEnv(options.env))
  if (options.agent !== false) plugins.push(hubAgent({
    ...options.agent,
    importBase: presetAgentImportBase,
    workspaceImportBase: presetWorkspaceImportBase,
  } as AgentModuleOptions))
  if (options.database !== false) plugins.push(hubDb(options.database))
  if (options.blob !== false) plugins.push(hubBlob(options.blob))
  if (options.kv !== false) plugins.push(hubKv(options.kv))
  if (options.queue) plugins.push(hubQueue(options.queue === true ? {} : options.queue))
  if (options.sandbox !== false) plugins.push(hubSandbox(options.sandbox))
  if (options.schedule !== false) plugins.push(hubSchedule({
    ...options.schedule,
    runtimeImport: presetScheduleStaticRuntimeImport,
  } as ScheduleVitePluginOptions & { runtimeImport: string }))
  if (options.workflow !== false) plugins.push(hubWorkflow(options.workflow))
  if (options.workspace !== false) plugins.push(hubWorkspace(options.workspace))
  if (options.devtools !== false) plugins.push(hubDevtools(options.devtools))
  return plugins as PluginOption[]
}
