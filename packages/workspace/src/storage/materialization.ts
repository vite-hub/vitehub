import type { Workspace } from "../core/types.ts"

export const workspaceRevisionMaterializer: unique symbol = Symbol.for("vitehub.workspace.revisionMaterializer")

export interface WorkspaceRevisionMaterialization {
  archive?: Uint8Array
  files: number
  paths?: readonly string[]
  revision: string
  root: string
}

export interface WorkspaceRevisionMaterializer {
  currentRevision(options?: { abortSignal?: AbortSignal, refresh?: boolean }): Promise<string>
  materializeRevision(options?: { abortSignal?: AbortSignal, paths?: readonly string[] }): Promise<WorkspaceRevisionMaterialization>
}

export type WorkspaceRevisionMaterializerCarrier = {
  [workspaceRevisionMaterializer]?: WorkspaceRevisionMaterializer
}

export function forwardWorkspaceRevisionMaterializer(source: unknown, target: unknown): void {
  const materializer = (source as WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer]
  if (materializer) (target as WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = materializer
}

export function resolveWorkspaceRevisionMaterializer(workspace: Workspace): WorkspaceRevisionMaterializer | undefined {
  return (workspace as Workspace & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer]
}
