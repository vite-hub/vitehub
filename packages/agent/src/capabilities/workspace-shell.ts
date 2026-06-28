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
  AgentCapabilityContext,
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

async function sourceRequestHint(context: AgentCapabilityContext): Promise<string | false> {
  if (!context.workspace) return false
  let entries: Array<{ path: string, type: string }>
  try {
    entries = await context.workspace.fs.list(".vitehub/sources") as Array<{ path: string, type: string }>
  }
  catch {
    return false
  }
  const descriptors = entries
    .filter(entry => entry.type === "file" && entry.path.startsWith(".vitehub/sources/") && entry.path.endsWith(".json"))
    .sort((left, right) => left.path.localeCompare(right.path))

  if (!descriptors.length) return false

  return [
    "API-backed Sources you can inspect with curl:",
    ...descriptors.map((entry) => {
      const source = entry.path.slice(".vitehub/sources/".length, -".json".length)
      return `- ${source}: read \`${entry.path}\` before using curl.`
    }),
    "Use normal curl syntax that matches the descriptor.",
  ].join("\n")
}

export function workspaceShell(options: WorkspaceShellOptions = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName, WorkspaceShellCapabilityTypeContract> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  const commands = options.commands === undefined
    ? undefined
    : validateWorkspaceCommands(options.commands)
  const timeout = normalizeWorkspaceCommandTimeout(options.timeout, "workspaceShell({ timeout })")
  const commandInstructions = commands
    ? async (context: AgentCapabilityContext) => [
        await sourceRequestHint(context),
        `workspace_exec runs only configured commands in a trusted Workspace Session at the workspace root: ${commands.join(", ")}.`,
        mode === "write"
          ? "Successful workspace_exec commands are committed back to the Workspace Store."
          : "workspace_exec read mode can inspect through a trusted Workspace Session, but does not commit command changes.",
      ].filter(Boolean).join("\n\n")
    : undefined

  return defineCapability({
    id: "workspace-shell",
    instructions: commandInstructions ?? sourceRequestHint,
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
