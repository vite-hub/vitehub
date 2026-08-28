import { hasRuntimeType } from "./internal/runtime-type.ts"
import { sourceSnapshotMetaKey } from "./sources/materialization.ts"
import { resolveWorkspaceMetadataTarget } from "./storage/metadata-target.ts"
import type { WorkspaceEntry, WorkspaceSourceMaterializationStatus } from "./core/types.ts"

export async function listMaterializedWorkspaceEntries(workspace: unknown): Promise<WorkspaceEntry[] | undefined> {
  const metadata = await resolveWorkspaceMetadataTarget(workspace)
  return await metadata?.list?.("", { recursive: true })
}

export {
  normalizeWorkspaceSourceMetadata,
  normalizeWorkspaceSourcesMetadata,
  workspaceSourceGrantPaths,
} from "./sources/config.ts"
export type { WorkspaceSourceMetadata } from "./sources/config.ts"

export async function readWorkspaceSourceMaterializationStatus(
  workspace: unknown,
  source: string,
): Promise<WorkspaceSourceMaterializationStatus | undefined> {
  const metadata = await resolveWorkspaceMetadataTarget(workspace)
  const snapshot = await metadata?.getMeta?.(sourceSnapshotMetaKey(source))
  if (!hasRuntimeType(snapshot, "object") || snapshot === null) return
  // SAFETY: The runtime object check above establishes a string-keyed metadata record.
  const record = snapshot as Record<string, unknown>
  const status = record.status
  if (status !== "lazy" && status !== "updating" && status !== "ready" && status !== "error") return
  return {
    materializedAt: hasRuntimeType(record.materializedAt, "string") ? record.materializedAt : undefined,
    mountPath: hasRuntimeType(record.mountPath, "string") ? record.mountPath : "",
    source: hasRuntimeType(record.source, "string") ? record.source : source,
    status,
  }
}
