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
