import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import type { RealtimeDefinition } from "./types.ts"

/**
 * Checks a definition when the server loads it. A definition must say who can use its rooms: `auth: true`,
 * `authorize()`, or `access: "public"`. `history.checkpoint` needs a document that can record history: a Workspace
 * document, or an adapter with `checkpoint()`.
 */
export function defineRealtime(definition: RealtimeDefinition): RealtimeDefinition {
  assertRealtimeAccess(definition)
  assertRealtimeCheckpoint(definition)
  return definition
}

/** Rejects a definition that reaches the server without an access rule, such as a plain object in a JavaScript file. */
export function assertRealtimeAccess(definition: RealtimeDefinition): void {
  // Read through `unknown`: JavaScript definitions reach this check without the types.
  const access: unknown = definition.access
  const authorize: unknown = definition.authorize
  const auth = definition.auth === true
  const hasAuthorize = typeof authorize === "function"
  if (access !== undefined) {
    if (access !== "public") throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "not-public" })
    if (definition.auth !== undefined || authorize !== undefined) throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "public-with-rule" })
  }
  else if (!auth && !hasAuthorize) {
    throw realtimeErrorDiagnostics.REALTIME_MISSING_ACCESS()
  }
  if (auth && !definition.identify && definition.origins) {
    throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "origins-without-identify" })
  }
}

export function assertRealtimeCheckpoint(definition: RealtimeDefinition): void {
  if (!definition.document || !definition.history?.checkpoint) return
  const document = definition.document
  if ("load" in document && typeof document.checkpoint !== "function") throw realtimeErrorDiagnostics.REALTIME_CHECKPOINT_UNSUPPORTED()
}
