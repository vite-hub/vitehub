import { workspaceError } from "../core/errors.ts"
import { normalizeWorkspacePath } from "../core/path.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

// Workspace internals own these metadata keys:
// - `source:`: Source Sync state and legacy Source snapshots.
// - `workspace:`: Source snapshots, startup indexes, and build indexes.
// - `workspace-file-`: file owner records and file checkpoints.
// - `loader:`: loader cache records, such as file digests.
// Cleanup reads them to decide which files to remove, so public callers must not write them.
const internalMetaKeyPrefixes = ["source:", "workspace:", "workspace-file-", "loader:"]

export function isInternalWorkspaceMetaKey(key: string): boolean {
  // Some Stores map a key to a file path, so also compare the path form, case-insensitively.
  const forms = [key.toLowerCase(), normalizeWorkspacePath(key).toLowerCase()]
  return internalMetaKeyPrefixes.some(prefix => forms.some(form => form.startsWith(prefix)))
}

/** Rejects keys that Workspace internals own. Public `setMeta` calls this before it writes. */
export function assertPublicWorkspaceMetaKey(key: unknown): string {
  if (!hasRuntimeType(key, "string")) throw workspaceError("[vitehub] Workspace metadata keys must be strings.")
  if (isInternalWorkspaceMetaKey(key)) {
    throw workspaceError(`[vitehub] Workspace metadata key ${JSON.stringify(key)} is reserved for Workspace internals.`)
  }
  return key
}
