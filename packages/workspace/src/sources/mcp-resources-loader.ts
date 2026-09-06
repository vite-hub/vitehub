import type { WorkspaceSource, WorkspaceSourceInput } from "../core/types.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

type McpResourcesSourceLoader = (input: WorkspaceSourceInput) => Promise<WorkspaceSource> | WorkspaceSource

let mcpResourcesSourceLoader: McpResourcesSourceLoader | undefined

export function registerMcpResourcesSourceLoader(loader: McpResourcesSourceLoader): void {
  mcpResourcesSourceLoader = loader
}

export async function loadMcpResourcesSource(input: WorkspaceSourceInput): Promise<WorkspaceSource> {
  if (!mcpResourcesSourceLoader) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0062({ message: '[vitehub] Workspace Source provider "mcpResources" is not available from this runtime entry.' })
  }
  return await mcpResourcesSourceLoader(input)
}
