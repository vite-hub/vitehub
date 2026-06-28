import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"

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

export function workspaceShell(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition<AgentRuntimeConfig, WorkspaceName, WorkspaceShellCapabilityTypeContract> {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  return defineCapability({
    id: "workspace-shell",
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}
