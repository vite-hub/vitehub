import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"
import {
  normalizeWorkspaceCommandTimeout,
  validateWorkspaceCommands,
  workspaceCommandTools,
} from "./workspace-command.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentRuntimeConfig,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

type WorkspaceShellCapabilityTypeContract = {
  workspaceScopes: never
}

export interface WorkspaceShellOptions {
  commands?: string[]
  mode?: AgentCapabilityMode
  timeout?: number
}

export function workspaceShell(options: WorkspaceShellOptions = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName, WorkspaceShellCapabilityTypeContract> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  const commands = options.commands === undefined
    ? undefined
    : validateWorkspaceCommands(options.commands)
  const timeout = normalizeWorkspaceCommandTimeout(options.timeout, "workspaceShell({ timeout })")

  return defineCapability({
    id: "workspace-shell",
    metadata: commands ? { commands, mode, ...(timeout ? { timeout } : {}) } : undefined,
    mode,
    requires: [{ primitive: "workspace", workspace: { mode: commands ? "write" : mode, required: true } }],
    tools: ({ workspace }) => ({
      ...(mode === "write" && "write" in workspace.tools
        ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
        : workspace.tools.inspect()) as AgentToolSet,
      ...(commands ? workspaceCommandTools(commands, mode, timeout, workspace) : {}),
    }),
  })
}
