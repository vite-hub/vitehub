import { registerWorkspace } from "@vite-hub/workspace/runtime"

import {
  markWorkspaceAgentDefinitionRegistered,
  workspaceAgentOwnsWorkspaceDefinition,
  workspaceAgentWithSourceRoot,
  workspaceNameFromOptions,
} from "../workspace-agent.ts"

import type { AgentRuntimeConfig } from "../types.ts"
import type { WorkspaceAgentDefinition } from "../workspace-agent.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/runtime"

export interface RegisterWorkspaceAgentOptions<Name extends WorkspaceName = WorkspaceName> {
  name?: string
  sourceRootDir?: string
  workspace?: Name
}

export function registerWorkspaceAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
>(
  agent: WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>,
  options: RegisterWorkspaceAgentOptions<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS> {
  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return agent
  const sourceRootDir = agent.sourceRootDir ?? options.sourceRootDir
  const registeredAgent = sourceRootDir === undefined ? agent : workspaceAgentWithSourceRoot(agent, sourceRootDir)
  const workspaceName = workspaceNameFromOptions(agent.__vitehubWorkspaceAgentOptions as never, options)
  registerWorkspace(workspaceName, {
    ...registeredAgent,
    sourceRootDir,
  } as never)
  markWorkspaceAgentDefinitionRegistered(agent, workspaceName)
  return agent
}
