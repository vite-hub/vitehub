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
} from "../types.ts"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade, WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface WorkspaceShellOptions {
  commands?: string[] | "all"
  mode?: AgentCapabilityMode
  timeout?: number
}

function hasWritableTools(workspace: ReadonlyWorkspaceFacade): workspace is WritableWorkspaceFacade {
  return "write" in workspace.tools
}

export function workspaceShell(options: WorkspaceShellOptions = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  const commands = options.commands === undefined
    ? undefined
    : options.commands === "all"
      ? options.commands
      : validateWorkspaceCommands(options.commands)
  if (commands && mode !== "write") {
    throw agentDiagnostics.AGENT_R0297({ message: "[vitehub] workspaceShell({ commands }) requires mode: \"write\" because provider commands run in the active Workspace Session." })
  }
  const timeout = normalizeWorkspaceCommandTimeout(options.timeout, "workspaceShell({ timeout })")

  return defineCapability({
    id: "workspace-shell",
    metadata: commands ? { commands, mode, ...(timeout ? { timeout } : {}) } : undefined,
    mode,
    requires: [{ primitive: "workspace", workspace: { mode: commands ? "write" : mode, required: true } }],
    tools: ({ context, driver, workspace }) => {
      if (commands && driver?.kind !== "provider") {
        throw agentDiagnostics.AGENT_R0298({ message: "[vitehub] workspaceShell({ commands }) is available only to provider Drivers. Use sandbox() for model-backed command tools." })
      }
      return {
        ...(driver?.kind === "provider"
          ? {}
          : mode === "write" && hasWritableTools(workspace)
            ? workspace.tools.write({ sourceRequests: true })
            : workspace.tools.inspect({ sourceRequests: true })),
        ...(commands ? workspaceCommandTools(commands, mode, timeout, workspace, { context }) : {}),
      }
    },
  })
}
