export const workspaceStoreTarget = Symbol.for("vitehub.workspace.storeTarget")

export interface WorkspaceStoreTarget {
  provider: string
}

export type WorkspaceStoreTargetCarrier = {
  [workspaceStoreTarget]?: () => Promise<WorkspaceStoreTarget | undefined> | WorkspaceStoreTarget | undefined
}

export function forwardWorkspaceStoreTarget(source: unknown, target: unknown): void {
  const resolveTarget = (source as WorkspaceStoreTargetCarrier)[workspaceStoreTarget]
  if (resolveTarget) (target as WorkspaceStoreTargetCarrier)[workspaceStoreTarget] = resolveTarget.bind(source)
}

export async function resolveWorkspaceStoreTarget(source: unknown): Promise<WorkspaceStoreTarget | undefined> {
  return await (source as WorkspaceStoreTargetCarrier)[workspaceStoreTarget]?.()
}
