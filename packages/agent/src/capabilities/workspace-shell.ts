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
import type { WorkspaceDefinition, WorkspaceName } from "@vite-hub/workspace"

export interface WorkspaceShellOptions {
  commands?: string[] | "trusted-host"
  mode?: AgentCapabilityMode
  timeout?: number
}

function isTrustedHostRuntime(definition: WorkspaceDefinition | undefined): boolean {
  const runtime = definition?.runtime
  return runtime === "trusted-host"
    || typeof runtime === "object" && runtime !== null && runtime.type === "trusted-host"
}

export function workspaceShell(options: WorkspaceShellOptions = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  const commands = options.commands === undefined
    ? undefined
    : options.commands === "trusted-host"
      ? options.commands
      : validateWorkspaceCommands(options.commands)
  const timeout = normalizeWorkspaceCommandTimeout(options.timeout, "workspaceShell({ timeout })")

  return defineCapability({
    id: "workspace-shell",
    metadata: commands ? { commands, mode, ...(timeout ? { timeout } : {}) } : undefined,
    mode,
    requires: [{ primitive: "workspace", workspace: { mode: commands ? "write" : mode, required: true } }],
    tools: ({ workspace, workspaceDefinition }) => {
      if (commands === "trusted-host" && !isTrustedHostRuntime(workspaceDefinition)) {
        throw new Error("[vitehub] workspaceShell({ commands: \"trusted-host\" }) requires workspace.runtime: \"trusted-host\".")
      }
      return {
        ...(mode === "write" && "write" in workspace.tools
          ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
          : workspace.tools.inspect()) as AgentToolSet,
        ...(commands ? workspaceCommandTools(commands, mode, timeout, workspace) : {}),
      }
    },
  })
}
