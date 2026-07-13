import { fileURLToPath } from "node:url"

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
import type { PluginOption } from "vite"

export { env } from "@vite-hub/env/vite"

type InternalAgentPresetOptions = AgentModuleOptions & {
  importBase?: string
  runtimeCapabilityImportBase?: string
  scheduleRuntimeImport?: string
  workspaceImportBase?: string
}

type InternalSandboxPresetOptions = Extract<SandboxPublicOptions, object> & {
  typeImportBase?: string
}

type InternalSchedulePresetOptions = ScheduleVitePluginOptions & {
  runtimeImport?: string
}

type InternalWorkflowPresetOptions = Extract<WorkflowModuleOptions, object> & {
  agentImportBase?: string
  importBase?: string
}

const presetDependencyNames = [
  "@vite-hub/agent",
  "@vite-hub/blob",
  "@vite-hub/database",
  "@vite-hub/devtools",
  "@vite-hub/env",
  "@vite-hub/kv",
  "@vite-hub/queue",
  "@vite-hub/sandbox",
  "@vite-hub/schedule",
  "@vite-hub/workflow",
  "@vite-hub/workspace",
] as const

const presetDependencyResolver = {
  name: "@vite-hub/vite/dependencies",
  enforce: "pre" as const,
  resolveId(id: string, importer?: string) {
    const normalizedImporter = importer?.replace(/\\/g, "/")
    if (
      !normalizedImporter?.includes("/.vitehub/")
      && !normalizedImporter?.includes("virtual:vitehub-agent-cloudflare-state-exports")
    ) {
      return
    }
    if (!presetDependencyNames.some(name => id.startsWith(`${name}/`) || id === name)) return
    return fileURLToPath(import.meta.resolve(id))
  },
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
  const plugins: unknown[] = []
  if (options.env !== false) {
    const envOptions = options.env ?? {}
    plugins.push(hubEnv({
      ...envOptions,
      runtimeImports: {
        secret: "@vite-hub/vite/env/secret",
        server: "@vite-hub/vite/env/server",
        ...envOptions.runtimeImports,
      },
    }))
  }
  if (options.agent !== false) {
    const agentOptions: InternalAgentPresetOptions = {
      ...(options.agent ?? {}),
      importBase: "@vite-hub/vite/agent",
      runtimeCapabilityImportBase: "@vite-hub/vite",
      scheduleRuntimeImport: "@vite-hub/vite/schedule/runtime",
      workspaceImportBase: "@vite-hub/vite/workspace",
    }
    plugins.push(hubAgent(agentOptions))
  }
  if (options.database !== false) plugins.push(hubDb(options.database))
  if (options.blob !== false) plugins.push(hubBlob(options.blob))
  if (options.kv !== false) plugins.push(hubKv(options.kv))
  if (options.queue) plugins.push(hubQueue(options.queue === true ? {} : options.queue))
  if (options.sandbox !== false) {
    const sandboxOptions: InternalSandboxPresetOptions = {
      ...(options.sandbox ?? {}),
      typeImportBase: "@vite-hub/vite/sandbox",
    }
    plugins.push(hubSandbox(sandboxOptions))
  }
  if (options.schedule !== false) {
    const scheduleOptions: InternalSchedulePresetOptions = {
      ...(options.schedule ?? {}),
      runtimeImport: "@vite-hub/vite/schedule/runtime/static",
    }
    plugins.push(hubSchedule(scheduleOptions))
  }
  if (options.workflow !== false) {
    const workflowOptions: InternalWorkflowPresetOptions = {
      ...(options.workflow ?? {}),
      agentImportBase: "@vite-hub/vite/agent",
      importBase: "@vite-hub/vite/workflow",
    }
    plugins.push(hubWorkflow(workflowOptions))
  }
  if (options.workspace !== false) plugins.push(hubWorkspace(options.workspace))
  if (options.devtools !== false) plugins.push(hubDevtools(options.devtools))
  plugins.push(presetDependencyResolver)
  return plugins as PluginOption[]
}
