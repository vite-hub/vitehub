export const workspaceMetadataTarget: unique symbol = Symbol.for("vitehub.workspace.metadataTarget")

export interface WorkspaceMetadataTarget {
  getMeta?(key: string): Promise<unknown>
}

export type WorkspaceMetadataTargetCarrier = {
  [workspaceMetadataTarget]?: () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: unknown): void {
  const resolveTarget = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]
  if (resolveTarget) (target as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget] = resolveTarget.bind(source)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  return await (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]?.()
}
