import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"

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

export function workspaceShell(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  return defineCapability({
    id: "workspace-shell",
    instructions: sourceRequestHint,
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}
