import { defineGrant } from "@vite-hub/runtime/internal/grant"

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

const revisionMaterializerKey = Symbol("vitehub.workspace.revision-materializer")
const revisionMaterializer = defineGrant("vitehub.workspace.revision-materializer", (materializer: WorkspaceRevisionMaterializer) => materializer)

function readRevisionMaterializer(source: unknown): unknown {
  // SAFETY: Only the property read is asserted. The grant check rejects any value that this module did not issue.
  return source === null || source === undefined ? undefined : (source as { [revisionMaterializerKey]?: unknown })[revisionMaterializerKey]
}

/** Lets hosted sessions read and materialize Store revisions. Only Store implementations call it. */
export function provideWorkspaceRevisionMaterializer(owner: object, materializer: WorkspaceRevisionMaterializer): void {
  // SAFETY: The owner gets one private property that holds the grant.
  ;(owner as { [revisionMaterializerKey]?: unknown })[revisionMaterializerKey] = revisionMaterializer.issue(materializer)
}

export function forwardWorkspaceRevisionMaterializer(source: unknown, target: object): void {
  const grant = readRevisionMaterializer(source)
  // SAFETY: The target gets one private property that holds the grant.
  if (revisionMaterializer.isValid(grant)) (target as { [revisionMaterializerKey]?: unknown })[revisionMaterializerKey] = grant
}

export function resolveWorkspaceRevisionMaterializer(workspace: unknown): WorkspaceRevisionMaterializer | undefined {
  return revisionMaterializer.check(readRevisionMaterializer(workspace))
}
