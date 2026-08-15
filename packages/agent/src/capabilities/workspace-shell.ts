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

export interface WorkspaceShellOptions {
  commands?: string[] | "all"
  mode?: AgentCapabilityMode
  timeout?: number
}

export function workspaceShell(options: WorkspaceShellOptions = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  const commands = options.commands === undefined
    ? undefined
    : options.commands === "all"
      ? options.commands
      : validateWorkspaceCommands(options.commands)
  const timeout = normalizeWorkspaceCommandTimeout(options.timeout, "workspaceShell({ timeout })")

  return defineCapability({
    id: "workspace-shell",
    metadata: commands ? { commands, mode, ...(timeout ? { timeout } : {}) } : undefined,
    mode,
    requires: [{ primitive: "workspace", workspace: { mode: commands ? "write" : mode, required: true } }],
    tools: ({ driver, workspace }) => {
      return {
        ...(driver?.kind === "provider"
          ? {}
          : mode === "write" && "write" in workspace.tools
            ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
            : workspace.tools.inspect()) as AgentToolSet,
        ...(commands ? workspaceCommandTools(commands, mode, timeout, workspace) : {}),
      }
    },
  })
}
