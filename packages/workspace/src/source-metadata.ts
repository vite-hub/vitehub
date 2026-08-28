import { hasRuntimeType } from "./internal/runtime-type.ts"
import { readCurrentSourceSnapshot } from "./sources/materialization.ts"
import { resolveWorkspaceMetadataTarget } from "./storage/metadata-target.ts"
import type { WorkspaceEntry, WorkspaceSourceMaterializationStatus } from "./core/types.ts"
import type { WorkspaceSourceMetadata } from "./sources/config.ts"

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
  source: WorkspaceSourceMetadata,
): Promise<WorkspaceSourceMaterializationStatus | undefined> {
  const metadata = await resolveWorkspaceMetadataTarget(workspace)
  if (!metadata) return
  const snapshot = await readCurrentSourceSnapshot(metadata, source)
  if (!hasRuntimeType(snapshot, "object") || snapshot === null) return
  const status = snapshot.status
  if (status !== "lazy" && status !== "updating" && status !== "ready" && status !== "error") return
  return {
    materializedAt: hasRuntimeType(snapshot.materializedAt, "string") ? snapshot.materializedAt : undefined,
    mountPath: hasRuntimeType(snapshot.mountPath, "string") ? snapshot.mountPath : "",
    source: hasRuntimeType(snapshot.source, "string") ? snapshot.source : source.key,
    status,
  }
}
