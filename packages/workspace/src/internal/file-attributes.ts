import type { WorkspaceFile } from "../core/types.ts"

// Keep missing Local Store history distinct from an explicit attribute removal,
// without adding persistence details to WorkspaceFile's public shape.
const unavailableAttributes = new WeakSet<WorkspaceFile>()

export function markFileAttributesUnavailable(file: WorkspaceFile): WorkspaceFile {
  unavailableAttributes.add(file)
  return file
}

export function fileAttributesUnavailable(file: WorkspaceFile): boolean {
  return unavailableAttributes.has(file)
}
