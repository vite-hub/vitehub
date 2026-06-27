import { registerWorkspace } from "@vite-hub/workspace/runtime"

import { withAgentDefaults, workspaceAgentOwnsWorkspaceDefinition } from "../index.ts"
import { workspaceDefinitionFromOptions, workspaceNameFromOptions } from "../workspace-agent.ts"

import type { AgentRuntimeConfig } from "../types.ts"
import type { WorkspaceAgentDefaults, WorkspaceAgentDefinition } from "../workspace-agent.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/runtime"

export interface RegisterWorkspaceAgentOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceAgentDefaults<Name> {
  sourceRootDir?: string
}

export function registerWorkspaceAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
>(
  agent: WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>,
  options: RegisterWorkspaceAgentOptions<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS> {
  const preparedAgent = withAgentDefaults(agent as never, {
    inferredName: options.name,
    workspace: options.workspace,
  }) as WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>
  const workspaceOptions = preparedAgent.__vitehubWorkspaceAgentOptions
  if (!workspaceAgentOwnsWorkspaceDefinition(preparedAgent)) return preparedAgent
  const sourceRootDir = preparedAgent.sourceRootDir ?? options.sourceRootDir
  if (sourceRootDir !== undefined) {
    const configuredWorkspace = workspaceOptions.workspace as Record<string, unknown> & { sourceRootDir?: string }
    const workspace = {
      ...configuredWorkspace,
      sourceRootDir: configuredWorkspace.sourceRootDir ?? sourceRootDir,
    }
    Object.assign(preparedAgent, workspaceDefinitionFromOptions({
      ...workspaceOptions,
      workspace,
    } as never), {
      __vitehubWorkspaceAgentOptions: {
        ...workspaceOptions,
        workspace,
      },
    })
  }
  const workspaceName = workspaceNameFromOptions(preparedAgent.__vitehubWorkspaceAgentOptions as never, preparedAgent.__vitehubWorkspaceAgentDefaults)
  registerWorkspace(workspaceName, {
    ...preparedAgent,
    sourceRootDir,
  } as never)
  return preparedAgent
}
