import { Diagnostic } from "nostics"

const conflictCode = "REALTIME_R0014"

/** Thrown by a document adapter when the stored digest no longer matches `ifDigest`. */
export class RealtimeDocumentConflict extends Diagnostic {
  constructor(why = "The stored document changed since the realtime room loaded it.") {
    super({ code: conflictCode, docs: "https://vitehub.dev/docs/reference/diagnostics", why }, RealtimeDocumentConflict)
    this.name = "RealtimeDocumentConflict"
  }
}

export function isRealtimeDocumentConflict(error: unknown): boolean {
  if (error instanceof RealtimeDocumentConflict) return true
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Conflicts thrown by another bundle copy are matched by their diagnostic code.
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === conflictCode
}
