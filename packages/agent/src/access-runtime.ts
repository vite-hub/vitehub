import type { ReadonlyWorkspaceFacade, WorkspaceName } from "@vite-hub/workspace"

export const workspaceOverrideSymbol: unique symbol = Symbol("vitehub.agent.workspaceOverride")

export interface WorkspaceOverrideRuntime<Name extends WorkspaceName = WorkspaceName> {
  [workspaceOverrideSymbol]: (workspace: ReadonlyWorkspaceFacade<Name>) => void
}
