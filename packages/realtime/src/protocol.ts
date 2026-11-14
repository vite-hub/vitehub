import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import type { RealtimeReadOnlyReason, RealtimeResetReason, RealtimeWorkspaceChange } from "./types.ts"
import { normalizeSafeWorkspacePath } from "@vite-hub/workspace/internal/path"

import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

export const messageWorkspaceChange = 4
/** Server-to-client JSON control frame: the room session on open, or a reset before closing. */
export const messageRealtimeControl = 5
export const messageAwareness = 1
/**
 * A JSON request from the server to the one browser in a room, or that browser's answer. Only rooms of a presence
 * Definition with `requests: true` carry it. `kind` tells the direction, so a request from the browser can be added.
 */
export const messageRealtimeRequest = 6
export const messageQueryAwareness = 3
export const workspaceRoomId = "@workspace"
/**
 * Text frames that keep an idle socket open. The client sends the ping, and the server answers with the pong. On
 * Cloudflare the Durable Object answers it without waking.
 */
export const realtimeKeepalivePing = "ping"
export const realtimeKeepalivePong = "pong"
export const maxAwarenessClients = 1024
export const realtimeSyncPendingCode = "REALTIME_SYNC_PENDING"
export const realtimeCheckpointRejectedCode = "REALTIME_CHECKPOINT_REJECTED"
export const realtimeSourceChangedCode = "REALTIME_SOURCE_CHANGED"
/** A save or checkpoint asked a room whose codec cannot edit the stored document without loss. */
export const realtimeReadOnlyCode = "REALTIME_READ_ONLY"
/** A save found that the room body does not fit the editor schema, so writing it would lose content. */
export const realtimeInvalidDocumentCode = "REALTIME_INVALID_DOCUMENT"
/** Close code sent after a reset control frame. The client must drop its Y.Doc. */
export const realtimeResetCloseCode = 4409
/** Close code for updates a peer may not write: read-only access or the server-written status. */
export const realtimeForbiddenWriteCloseCode = 4403

export function isRetryableRealtimeRequestCode(value: unknown): boolean {
  return value === realtimeSyncPendingCode
}

export function isRetryableRealtimeCheckpointCode(value: unknown): boolean {
  return value === realtimeSyncPendingCode || value === realtimeCheckpointRejectedCode
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
      if (value.access === "read" && "reason" in value && (value.reason === "access" || value.reason === "document" || value.reason === "version")) {
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

  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("//") || /^[a-z]:/i.test(value)) return false
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
  if (length > maxAwarenessClients) throw realtimeErrorDiagnostics.REALTIME_TOO_MANY_AWARENESS_CLIENTS({})
  const clients: number[] = []
  for (let index = 0; index < length; index++) {
    clients.push(decoding.readVarUint(decoder))
    decoding.readVarUint(decoder)
    decoding.readVarString(decoder)
  }
  return clients
}

export type RealtimeRequestFrame =
  | { kind: "request", id: string, body: unknown }
  | { kind: "answer", id: string, ok: true, body: unknown }
  | { kind: "answer", id: string, ok: false, why: string }

export function encodeRealtimeRequestFrame(frame: RealtimeRequestFrame): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageRealtimeRequest)
  encoding.writeVarString(encoder, JSON.stringify(frame))
  return encoding.toUint8Array(encoder)
}

/** Reads a request frame after its message type, or `undefined` when it is not one. */
export function decodeRealtimeRequestFramePayload(decoder: decoding.Decoder): RealtimeRequestFrame | undefined {
  try {
    const value: unknown = JSON.parse(decoding.readVarString(decoder))
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id || value.id.length > 128) return
    if (!("kind" in value)) return
    if (value.kind === "request") return { kind: "request", id: value.id, body: "body" in value ? value.body : undefined }
    if (value.kind !== "answer" || !("ok" in value)) return
    if (value.ok === true) return { kind: "answer", id: value.id, ok: true, body: "body" in value ? value.body : undefined }
    if (value.ok === false && "why" in value && typeof value.why === "string") return { kind: "answer", id: value.id, ok: false, why: value.why }
  }
  catch {}
}
