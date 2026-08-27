export const workspaceMetadataTarget: unique symbol = Symbol.for("vitehub.workspace.metadataTarget")

export interface WorkspaceMetadataTarget {
  getMeta?(key: string): Promise<unknown>
}

export type WorkspaceMetadataTargetCarrier = {
  [workspaceMetadataTarget]?: () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: unknown): void {
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  const resolveTarget = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]
  // SAFETY: Metadata target forwarding writes only the private symbol member owned by this module.
  if (resolveTarget) (target as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget] = resolveTarget.bind(source)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  return await (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]?.()
}
