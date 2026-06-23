import type { ReadonlyWorkspaceFacade, WorkspaceName } from "@vite-hub/workspace"
import type { AgentInvocationContextStore } from "./types.ts"

export const workspaceOverrideSymbol: unique symbol = Symbol.for("vitehub.agent.workspaceOverride") as never
const trustedSourceResolutionDefinitions = new WeakSet<AgentInvocationContextStore>()
const trustedWorkspaceAccessScopes = new WeakSet<AgentInvocationContextStore>()

export interface WorkspaceOverrideRuntime<Name extends WorkspaceName = WorkspaceName> {
  [workspaceOverrideSymbol]: (workspace: ReadonlyWorkspaceFacade<Name>) => void
}

export function markTrustedWorkspaceSourceResolutionDefinition(context: AgentInvocationContextStore): void {
  trustedSourceResolutionDefinitions.add(context)
}

export function hasTrustedWorkspaceSourceResolutionDefinition(context: AgentInvocationContextStore): boolean {
  return trustedSourceResolutionDefinitions.has(context)
}

export function markTrustedWorkspaceAccessScope(context: AgentInvocationContextStore): void {
  trustedWorkspaceAccessScopes.add(context)
}

export function hasTrustedWorkspaceAccessScope(context: AgentInvocationContextStore): boolean {
  return trustedWorkspaceAccessScopes.has(context)
}
