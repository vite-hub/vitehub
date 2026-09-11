/** Host-authorized inspection of a retained invocation Workspace. */
export type AgentHostWorkspaceInspector = (id: string, path?: string) => Response | Promise<Response>

export const agentHostWorkspaceRoute = "/api/_vitehub/console/invocations/:id/workspace"
const inspectorsKey: unique symbol = Symbol.for("vitehub.agent.host-workspace-inspectors")
// SAFETY: This module owns the process registry shared by separately bundled host and Console modules.
const state = globalThis as typeof globalThis & { [inspectorsKey]?: Map<string, AgentHostWorkspaceInspector> }

/** Register only routes explicitly enabled by the application through agentHostRoutes. */
export function registerAgentHostWorkspaceInspector(route: string, inspector: AgentHostWorkspaceInspector): void {
  const inspectors = state[inspectorsKey] ??= new Map()
  inspectors.set(route, inspector)
}

export function getAgentHostWorkspaceInspector(route: string): AgentHostWorkspaceInspector | undefined {
  return state[inspectorsKey]?.get(route)
}
