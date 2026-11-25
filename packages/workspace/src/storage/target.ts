import { defineGrant } from "@vite-hub/runtime/internal/grant"

export interface WorkspaceStoreTarget {
  provider: string
  containsPath?(ancestor: string, path: string): Promise<boolean>
}

export type WorkspaceStoreTargetResolver = () => Promise<WorkspaceStoreTarget | undefined> | WorkspaceStoreTarget | undefined

const storeTargetKey = Symbol("vitehub.workspace.store-target")
const storeTarget = defineGrant("vitehub.workspace.store-target", (resolve: WorkspaceStoreTargetResolver) => resolve)

function readStoreTarget(source: unknown): unknown {
  // SAFETY: Only the property read is asserted. The grant check rejects any value that this module did not issue.
  return source === null || source === undefined ? undefined : (source as { [storeTargetKey]?: unknown })[storeTargetKey]
}

/** Records where a Store or Workspace keeps its files. Only Store implementations and Workspace wrappers call it. */
export function provideWorkspaceStoreTarget(owner: object, resolve: WorkspaceStoreTargetResolver): void {
  // SAFETY: The owner gets one private property that holds the grant.
  ;(owner as { [storeTargetKey]?: unknown })[storeTargetKey] = storeTarget.issue(resolve)
}

export function forwardWorkspaceStoreTarget(source: unknown, target: object): void {
  const grant = readStoreTarget(source)
  // SAFETY: The target gets one private property that holds the grant.
  if (storeTarget.isValid(grant)) (target as { [storeTargetKey]?: unknown })[storeTargetKey] = grant
}

export async function resolveWorkspaceStoreTarget(source: unknown): Promise<WorkspaceStoreTarget | undefined> {
  return await storeTarget.check(readStoreTarget(source))?.()
}
