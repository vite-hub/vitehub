import { hubAgent } from "@vite-hub/agent/vite"
import { hubDb } from "@vite-hub/database/vite"
import { hubDevtools } from "@vite-hub/devtools"
import { hubEnv } from "@vite-hub/env/vite"
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"

import type { AgentModuleOptions } from "@vite-hub/agent"
import type { DBModulePublicOptions } from "@vite-hub/database"
import type { HubDevtoolsOptions } from "@vite-hub/devtools"
import type { EnvIntegrationOptions } from "@vite-hub/env"
import type { WorkflowModuleOptions } from "@vite-hub/workflow"
import type { WorkspaceModuleOptions } from "@vite-hub/workspace"
import type { PluginOption } from "vite"

export { env } from "@vite-hub/env/vite"

export interface ViteHubPresetOptions {
  agent?: false | AgentModuleOptions
  database?: false | DBModulePublicOptions
  devtools?: false | HubDevtoolsOptions
  env?: false | EnvIntegrationOptions
  workflow?: false | WorkflowModuleOptions
  workspace?: false | WorkspaceModuleOptions
}

export function vitehub(options: ViteHubPresetOptions = {}): PluginOption[] {
  const plugins: unknown[] = []
  if (options.env !== false) plugins.push(hubEnv(options.env))
  if (options.agent !== false) plugins.push(hubAgent(options.agent))
  if (options.database !== false) plugins.push(hubDb(options.database))
  if (options.workflow !== false) plugins.push(hubWorkflow(options.workflow))
  if (options.workspace !== false) plugins.push(hubWorkspace(options.workspace))
  if (options.devtools !== false) plugins.push(hubDevtools(options.devtools))
  return plugins as PluginOption[]
}
