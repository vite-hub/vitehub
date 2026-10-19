import { Diagnostic } from "nostics"

import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

const conflictCode = "REALTIME_DOCUMENT_CONFLICT"

/** Thrown by a document adapter when the stored digest no longer matches `ifDigest`. */
export class RealtimeDocumentConflict extends Diagnostic {
  constructor(why?: string) {
    const { code, docs, fix } = realtimeErrorDiagnostics.REALTIME_DOCUMENT_CONFLICT({ problem: why })
    super({ code, docs, fix, why: why ?? "The stored document changed since the realtime room loaded it." }, RealtimeDocumentConflict)
    this.name = "RealtimeDocumentConflict"
  }
}

export function isRealtimeDocumentConflict(error: unknown): boolean {
  if (error instanceof RealtimeDocumentConflict) return true
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === conflictCode
}
