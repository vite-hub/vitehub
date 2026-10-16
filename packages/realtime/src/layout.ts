import type * as Y from "yjs"

import type { RealtimeDocumentStatus, RealtimeIssue, RealtimeUser } from "./types.ts"

/**
 * Root types of every Realtime Y.Doc:
 * - `body`: Y.XmlFragment bound to the editor through TipTap Collaboration.
 * - `fields`: Y.Map with one JSON value per field; concurrent writes to one key resolve last-write-wins.
 * - `status`: Y.Map written only by the server (`digest`, `error`, `issues`, `savedAt`, `savedBy`).
 *   The server closes connections whose updates change it.
 */
export const realtimeDocumentLayout = Object.freeze({ body: "body", fields: "fields", status: "status" } as const)

function text(value: unknown): string | null {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Status values cross the Yjs boundary as unknown JSON.
  return typeof value === "string" ? value : null
}

export function readRealtimeStatus(document: Y.Doc): RealtimeDocumentStatus {
  const map = document.getMap<unknown>(realtimeDocumentLayout.status)
  const issues = map.get("issues")
  const savedBy = map.get("savedBy")
  // SAFETY: Only the server writes `status` (RealtimeIssue[] and RealtimeUser); it disconnects clients that change it.
  const status = { issues: Array.isArray(issues) ? issues as RealtimeIssue[] : [], savedBy: savedBy && !Array.isArray(savedBy) && savedBy instanceof Object ? savedBy as RealtimeUser : null }
  return {
    digest: text(map.get("digest")),
    error: text(map.get("error")),
    issues: status.issues,
    savedAt: text(map.get("savedAt")),
    savedBy: status.savedBy,
  }
}
