import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { WorkspaceDefinition, WorkspacePlugin } from "./types.ts"

const contributedPluginsKey = Symbol.for("vitehub.workspace.contributedPlugins")

interface ContributedPluginState {
  plugins: Map<string, Map<string, WorkspacePlugin>>
  version: number
}

type ContributedPluginGlobal = typeof globalThis & Record<symbol, ContributedPluginState | undefined>

// Shared across module copies so a plugin registered by one bundle reaches every Workspace facade.
function contributedPluginState(): ContributedPluginState {
  // SAFETY: Only this module writes the private global symbol, always with ContributedPluginState.
  const scope = globalThis as ContributedPluginGlobal
  scope[contributedPluginsKey] ??= { plugins: new Map(), version: 0 }
  return scope[contributedPluginsKey]
}

/**
 * Add a plugin's rules and hooks to a Workspace by name, including discovered Workspaces the caller does not define.
 * Registering the same plugin id again replaces the earlier registration. A plugin declared by the Workspace Definition
 * with the same id wins. The returned function removes this registration.
 */
export function registerWorkspacePlugin(workspace: string, plugin: WorkspacePlugin): () => void {
  if (!hasRuntimeType(workspace, "string") || !workspace) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0022({ message: "[vitehub] registerWorkspacePlugin requires a Workspace name." })
  }
  if (!plugin || !hasRuntimeType(plugin.id, "string") || !plugin.id) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0024({ message: "[vitehub] Workspace plugins require an id." })
  }
  const state = contributedPluginState()
  let plugins = state.plugins.get(workspace)
  if (!plugins) state.plugins.set(workspace, plugins = new Map())
  plugins.set(plugin.id, plugin)
  state.version++
  return () => {
    if (state.plugins.get(workspace)?.get(plugin.id) !== plugin) return
    plugins.delete(plugin.id)
    if (!plugins.size) state.plugins.delete(workspace)
    state.version++
  }
}

/** Changes whenever a contributed plugin is added, replaced, or removed. */
export function workspacePluginsVersion(): number {
  return contributedPluginState().version
}

/** The Definition's own plugins followed by contributed plugins with other ids. */
export function workspaceDefinitionPlugins(definition: Pick<WorkspaceDefinition, "name" | "plugins">): WorkspacePlugin[] {
  const own = definition.plugins ?? []
  const contributed = contributedPluginState().plugins.get(definition.name)
  if (!contributed?.size) return own
  const ids = new Set(own.map(plugin => plugin?.id))
  return [...own, ...[...contributed.values()].filter(plugin => !ids.has(plugin.id))]
}
