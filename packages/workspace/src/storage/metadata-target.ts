export const workspaceMetadataName: unique symbol = Symbol.for("vitehub.workspace.metadataName")

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
  [workspaceMetadataName]?: string
  [workspaceMetadataTarget]?: () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: unknown): void {
  // SAFETY: Metadata forwarding reads and writes only private symbols owned by this module.
  const name = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataName]
  // SAFETY: Forward only the private Workspace name marker to the receiving facade.
  if (name !== undefined) (target as WorkspaceMetadataTargetCarrier)[workspaceMetadataName] = name
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  const resolveTarget = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]
  // SAFETY: Metadata target forwarding writes only the private symbol member owned by this module.
  if (resolveTarget) (target as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget] = resolveTarget.bind(source)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  return await (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]?.()
}

export function resolveWorkspaceMetadataName(source: unknown): string | undefined {
  // SAFETY: Metadata name resolution reads only the private symbol owned by this module.
  return (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataName]
}
