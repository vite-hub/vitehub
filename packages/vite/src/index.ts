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
import type { AliasOptions, Plugin, PluginOption } from "vite"

export { env } from "@vite-hub/env/vite"

const facadeAliases: Record<string, string> = {
  "@vite-hub/agent": "@vite-hub/vite/agent",
  "@vite-hub/agent/cloudflare": "@vite-hub/vite/agent/cloudflare",
  "@vite-hub/agent/cloudflare/state": "@vite-hub/vite/agent/cloudflare/state",
  "@vite-hub/agent/runtime/workflow": "@vite-hub/vite/agent/runtime/workflow",
  "@vite-hub/agent/server": "@vite-hub/vite/agent/server",
  "@vite-hub/agent/server/routes": "@vite-hub/vite/agent/server/routes",
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

function mergeFacadeAliases(alias: AliasOptions | undefined): AliasOptions {
  const entries = Object.entries(facadeAliases).map(([find, replacement]) => ({ find, replacement }))
  if (Array.isArray(alias)) return [...alias, ...entries]
  return { ...facadeAliases, ...(alias && typeof alias === "object" ? alias : {}) }
}

function vitehubFacadeAlias(): Plugin {
  return {
    name: "@vite-hub/vite/facade-alias",
    enforce: "pre",
    config(config) {
      return { resolve: { alias: mergeFacadeAliases(config.resolve?.alias) } }
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
  if (options.agent !== false) plugins.push(hubAgent(options.agent))
  if (options.database !== false) plugins.push(hubDb(options.database))
  if (options.blob !== false) plugins.push(hubBlob(options.blob))
  if (options.kv !== false) plugins.push(hubKv(options.kv))
  if (options.queue) plugins.push(hubQueue(options.queue === true ? {} : options.queue))
  if (options.sandbox !== false) plugins.push(hubSandbox(options.sandbox))
  if (options.schedule !== false) plugins.push(hubSchedule(options.schedule))
  if (options.workflow !== false) plugins.push(hubWorkflow(options.workflow))
  if (options.workspace !== false) plugins.push(hubWorkspace(options.workspace))
  if (options.devtools !== false) plugins.push(hubDevtools(options.devtools))
  return plugins as PluginOption[]
}
