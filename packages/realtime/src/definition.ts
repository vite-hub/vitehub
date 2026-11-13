import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import type { RealtimeDefinition } from "./types.ts"

/**
 * Checks a definition when the server loads it. `history.checkpoint` needs a document that can record history: a
 * Workspace document, or an adapter with `checkpoint()`.
 */
export function defineRealtime(definition: RealtimeDefinition): RealtimeDefinition {
  assertRealtimeCheckpoint(definition)
  return definition
}

export function assertRealtimeCheckpoint(definition: RealtimeDefinition): void {
  if (!definition.document || !definition.history?.checkpoint) return
  const document = definition.document
  if ("load" in document && typeof document.checkpoint !== "function") throw realtimeErrorDiagnostics.REALTIME_CHECKPOINT_UNSUPPORTED()
}
