import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"

import type { RealtimeWorkspaceChange } from "./types.ts"

export const messageWorkspaceChange = 4
export const messageAwareness = 1
export const messageQueryAwareness = 3
export const workspaceRoomId = "@workspace"
export const maxAwarenessClients = 1024

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
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
  if (length > maxAwarenessClients) throw new TypeError("Awareness update contains too many clients.")
  const clients: number[] = []
  for (let index = 0; index < length; index++) {
    clients.push(decoding.readVarUint(decoder))
    decoding.readVarUint(decoder)
    decoding.readVarString(decoder)
  }
  return clients
}
