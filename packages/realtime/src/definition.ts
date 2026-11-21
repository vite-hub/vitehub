import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import type { RealtimeDefinition } from "./types.ts"

/**
 * Checks a definition when the server loads it. A definition must say who can use its rooms: `authorize: true`,
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
  // `auth` was the old spelling of `authorize: true`. Next to an `authorize()` callback it required a signed-in user, so
  // a definition that still sets it must not load as one that lets signed-out callers reach the callback.
  if ("auth" in definition) throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "auth" })
  if (access !== undefined) {
    if (access !== "public") throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "not-public" })
    if (authorize !== undefined) throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "public-with-rule" })
  }
  else if (authorize === undefined) {
    throw realtimeErrorDiagnostics.REALTIME_MISSING_ACCESS()
  }
  else if (authorize !== true && typeof authorize !== "function") {
    throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "not-authorize" })
  }
  if (authorize === true && !definition.identify && definition.origins) {
    throw realtimeErrorDiagnostics.REALTIME_INVALID_ACCESS({ reason: "origins-without-identify" })
  }
}

export function assertRealtimeCheckpoint(definition: RealtimeDefinition): void {
  if (!definition.document || !definition.history?.checkpoint) return
  const document = definition.document
  if ("load" in document && typeof document.checkpoint !== "function") throw realtimeErrorDiagnostics.REALTIME_CHECKPOINT_UNSUPPORTED()
}
