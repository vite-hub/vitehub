import { defineGrant } from "@vite-hub/runtime/internal/grant"

import type { ReadonlyWorkspaceFacade, WorkspaceName } from "@vite-hub/workspace"
import type { AgentAccessWorkspaceScopeContext, AgentInvocationContextStore } from "./types.ts"

export const workspaceOverrideSymbol: unique symbol = Symbol.for("vitehub.agent.workspaceOverride") as never
const trustedSourceResolutionDefinitions = new WeakSet<AgentInvocationContextStore>()
const trustedSourceFreeInspections = new WeakSet<AgentInvocationContextStore>()
const workspaceAccessWrappers = new WeakMap<AgentInvocationContextStore, (workspace: ReadonlyWorkspaceFacade) => ReadonlyWorkspaceFacade>()

/**
 * Frozen Workspace Scope that `access()` resolved for one invocation context.
 * Only `grantWorkspaceAccessScope()` creates it. The `"access"` context key is a
 * public copy for user code and is never read as authority.
 */
export interface WorkspaceAccessScopeGrant {
  readonly all: boolean
  readonly paths: readonly string[]
  readonly role: AgentAccessWorkspaceScopeContext["role"]
  readonly scope: string
  readonly sources: readonly string[]
}

const workspaceAccessScope = defineGrant("vitehub.agent.workspace-access-scope", (scope: WorkspaceAccessScopeGrant): WorkspaceAccessScopeGrant => Object.freeze({
  all: scope.all === true,
  paths: Object.freeze([...scope.paths]),
  role: scope.role,
  scope: scope.scope,
  sources: Object.freeze([...scope.sources]),
}))

export interface WorkspaceOverrideRuntime<Name extends WorkspaceName = WorkspaceName> {
  [workspaceOverrideSymbol]: (workspace: ReadonlyWorkspaceFacade<Name>) => void
}

export function markTrustedWorkspaceSourceResolutionDefinition(context: AgentInvocationContextStore): void {
  trustedSourceResolutionDefinitions.add(context)
}

export function hasTrustedWorkspaceSourceResolutionDefinition(context: AgentInvocationContextStore): boolean {
  return trustedSourceResolutionDefinitions.has(context)
}

export function grantWorkspaceAccessScope(
  context: AgentInvocationContextStore,
  scope: WorkspaceAccessScopeGrant,
): void {
  const grant = workspaceAccessScope.issue(scope)
  const granted = workspaceAccessScope.verify(grant)
  // A pre-existing grant may update its own public copy. A first grant must not replace a caller value.
  const overwrite = workspaceAccessScope.attached(context) !== undefined
  context.set("access", {
    workspaceScope: {
      all: granted.all,
      paths: [...granted.paths],
      role: granted.role,
      scope: granted.scope,
      sources: [...granted.sources],
    },
  }, { overwrite })
  workspaceAccessScope.attach(context, grant)
}

/** Returns the Workspace Scope that `access()` granted, or `undefined`. Values written to the `"access"` key are ignored. */
export function trustedWorkspaceAccessScope(context: AgentInvocationContextStore): WorkspaceAccessScopeGrant | undefined {
  return workspaceAccessScope.check(workspaceAccessScope.attached(context))
}

export function registerWorkspaceAccessWrapper(
  context: AgentInvocationContextStore,
  wrapper: (workspace: ReadonlyWorkspaceFacade) => ReadonlyWorkspaceFacade,
): void {
  workspaceAccessWrappers.set(context, wrapper)
}

export function applyWorkspaceAccessWrapper(
  context: AgentInvocationContextStore,
  workspace: ReadonlyWorkspaceFacade,
): ReadonlyWorkspaceFacade {
  return workspaceAccessWrappers.get(context)?.(workspace) ?? workspace
}

export function markTrustedSourceFreeInspection(context: AgentInvocationContextStore): void {
  trustedSourceFreeInspections.add(context)
}

export function isTrustedSourceFreeInspection(context: AgentInvocationContextStore): boolean {
  return trustedSourceFreeInspections.has(context)
}
