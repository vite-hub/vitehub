export const workspaceMetadataTarget: unique symbol = Symbol.for("vitehub.workspace.metadataTarget")

import type { ListOptions, MkdirOptions, RmOptions, WorkspaceEntry, WorkspaceFile } from "../core/types.ts"

export interface WorkspaceMetadataTarget {
  readFile?(path: string): Promise<WorkspaceFile | undefined>
  writeFile?(path: string, file: WorkspaceFile): Promise<void>
  mkdir?(path: string, options?: MkdirOptions): Promise<void>
  rm?(path: string, options?: RmOptions): Promise<void>
  getMeta?(key: string): Promise<unknown>
  list?(path: string, options?: ListOptions): Promise<WorkspaceEntry[]>
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
