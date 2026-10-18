import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"

import type { RealtimeReadOnlyReason, RealtimeResetReason, RealtimeWorkspaceChange } from "./types.ts"

import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import { normalizeSafeWorkspacePath } from "@vite-hub/workspace"

export const messageWorkspaceChange = 4
/** Server-to-client JSON control frame: the room session on open, or a reset before closing. */
export const messageRealtimeControl = 5
export const messageAwareness = 1
export const messageQueryAwareness = 3
export const workspaceRoomId = "@workspace"
export const maxAwarenessClients = 1024
export const realtimeSyncPendingCode = "REALTIME_SYNC_PENDING"
export const realtimeSourceChangedCode = "REALTIME_SOURCE_CHANGED"
/** A save or checkpoint asked a room whose codec cannot edit the stored document without loss. */
export const realtimeReadOnlyCode = "REALTIME_READ_ONLY"
/** Close code sent after a reset control frame. The client must drop its Y.Doc. */
export const realtimeResetCloseCode = 4409
/** Close code for updates a peer may not write: read-only access or the server-written status. */
export const realtimeForbiddenWriteCloseCode = 4403

export function isRetryableRealtimeRequestCode(value: unknown): boolean {
  return value === realtimeSyncPendingCode
}

export type RealtimeControlMessage =
  | { type: "session", access: "read" | "write", epoch: string, reason?: RealtimeReadOnlyReason }
  | { type: "reset", epoch: string, reason: RealtimeResetReason }

export function encodeRealtimeControl(message: RealtimeControlMessage): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageRealtimeControl)
  encoding.writeVarString(encoder, JSON.stringify(message))
  return encoding.toUint8Array(encoder)
}

export function decodeRealtimeControlPayload(decoder: decoding.Decoder): RealtimeControlMessage | undefined {
  try {
    const value: unknown = JSON.parse(decoding.readVarString(decoder))
    if (!value || typeof value !== "object" || !("epoch" in value) || !("type" in value)) return
    if (typeof value.epoch !== "string" || !value.epoch) return
    if (value.type === "session" && "access" in value && (value.access === "read" || value.access === "write")) {
      if (value.access === "read" && "reason" in value && (value.reason === "access" || value.reason === "document")) {
        return { type: "session", access: value.access, epoch: value.epoch, reason: value.reason }
      }
      return { type: "session", access: value.access, epoch: value.epoch }
    }
    if (value.type === "reset" && "reason" in value && (value.reason === "source-changed" || value.reason === "stale")) {
      return { type: "reset", epoch: value.epoch, reason: value.reason }
    }
  }
  catch {}
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) return false
  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false
  if (value.includes("//")) return false
  try {
    return normalizeSafeWorkspacePath(value) === value
  }
  catch {
    return false
  }

}

export function decodeWorkspaceChangePayload(decoder: decoding.Decoder): RealtimeWorkspaceChange | undefined {
  try {
    const value = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown>
    if ((value.operation === "create" || value.operation === "delete" || value.operation === "update") && validPath(value.path)) {
      return { operation: value.operation, path: value.path }
    }
    if (value.operation === "move" && validPath(value.from) && validPath(value.to)) {
      return { operation: value.operation, from: value.from, to: value.to }
    }
  }
  catch {}
}

export function decodeWorkspaceChange(message: Uint8Array): RealtimeWorkspaceChange | undefined {
  const decoder = decoding.createDecoder(message)
  if (decoding.readVarUint(decoder) !== messageWorkspaceChange) return
  return decodeWorkspaceChangePayload(decoder)
}

export function encodeWorkspaceChange(change: RealtimeWorkspaceChange): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageWorkspaceChange)
  encoding.writeVarString(encoder, JSON.stringify(change))
  return encoding.toUint8Array(encoder)
}

export function readAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update)
  const length = decoding.readVarUint(decoder)
  if (length > maxAwarenessClients) throw realtimeErrorDiagnostics.REALTIME_TOO_MANY_AWARENESS_CLIENTS()
  const clients: number[] = []
  for (let index = 0; index < length; index++) {
    clients.push(decoding.readVarUint(decoder))
    decoding.readVarUint(decoder)
    decoding.readVarString(decoder)
  }
  return clients
}
