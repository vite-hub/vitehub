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

  override toJSON(): {
    code: string
    data: undefined
    docs: string | undefined
    fix: string | undefined
    name: string
    why: string
  } {
    return {
      code: this.code,
      // Nostics requires this key; undefined keeps diagnostic data out of public JSON.
      data: undefined,
      docs: this.docs,
      fix: this.fix,
      name: this.name,
      why: this.why,
    }
  }
}

export function isRealtimeDocumentConflict(error: unknown): boolean {
  if (error instanceof RealtimeDocumentConflict) return true
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === conflictCode
}
