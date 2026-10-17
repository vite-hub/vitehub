import { isPlainObject } from "@vite-hub/internal/object"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import { Diagnostic } from "nostics"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import type { RealtimeIdentity } from "./presence.ts"
import { maxAwarenessClients, readAwarenessClientIds } from "./protocol.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

const maxRoomAwarenessBytes = 8 * 1024 * 1024

export function claimAwarenessClientIds<Peer extends object>(owners: Map<number, Peer>, peer: Peer, clients: number[]): number[] {
  for (const client of clients) {
    const owner = owners.get(client)
    if (owner && owner !== peer) throw new AwarenessOwnershipConflict()
  }
  const ownedClients = new Set(
    [...owners].filter(([, owner]) => owner === peer).map(([client]) => client),
  )
  for (const client of clients) ownedClients.add(client)
  if (ownedClients.size > maxAwarenessClients) {
    throw realtimeErrorDiagnostics.REALTIME_R0003({ message: "Peer owns too many awareness clients." })
  }
  const claimed = clients.filter(client => !owners.has(client))
  for (const client of clients) owners.set(client, peer)
  return claimed
}

export class AwarenessOwnershipConflict extends Diagnostic {
  constructor() {
    super({ code: "REALTIME_R0013", docs: "https://vitehub.dev/docs/reference/diagnostics", why: "Awareness client id is already owned by another peer." }, AwarenessOwnershipConflict)
    this.name = "AwarenessOwnershipConflict"
  }
}

export function bindAwarenessIdentity(update: Uint8Array, identity: RealtimeIdentity): Uint8Array {
  return awarenessProtocol.modifyAwarenessUpdate(update, (state: unknown) => {
    if (state === null) return null
    if (!isPlainObject(state)) throw realtimeErrorDiagnostics.REALTIME_R0004({ message: "Invalid awareness state." })
    return { ...state, user: identity }
  })
}

export function applyRealtimeAwarenessUpdate(
  awareness: awarenessProtocol.Awareness,
  update: Uint8Array,
  origin: unknown,
  maxStateBytes = maxRoomAwarenessBytes,
): void {
  const candidateDocument = new Y.Doc()
  const candidate = new awarenessProtocol.Awareness(candidateDocument)
  candidate.setLocalState(null)
  let stateBytes: number
  try {
    const currentClients = [...awareness.getStates().keys()]
    if (currentClients.length) {
      awarenessProtocol.applyAwarenessUpdate(candidate, awarenessProtocol.encodeAwarenessUpdate(awareness, currentClients), origin)
    }
    awarenessProtocol.applyAwarenessUpdate(candidate, update, origin)
    const candidateClients = [...candidate.getStates().keys()]
    stateBytes = candidateClients.length
      ? awarenessProtocol.encodeAwarenessUpdate(candidate, candidateClients).byteLength
      : 0
  }
  finally {
    candidate.destroy()
    candidateDocument.destroy()
  }
  if (stateBytes > maxStateBytes) throw realtimeErrorDiagnostics.REALTIME_R0006({ message: "Realtime awareness exceeds its 8 MiB room quota." })
  awarenessProtocol.applyAwarenessUpdate(awareness, update, origin)
}

export function compactRealtimeAwareness(awareness: awarenessProtocol.Awareness): awarenessProtocol.Awareness {
  const clients = [...awareness.getStates().keys()]
  const update = clients.length ? awarenessProtocol.encodeAwarenessUpdate(awareness, clients) : undefined
  const compacted = new awarenessProtocol.Awareness(awareness.doc)
  compacted.setLocalState(null)
  if (update) awarenessProtocol.applyAwarenessUpdate(compacted, update, "compaction")
  awareness.destroy()
  return compacted
}

/**
 * Drops the entries of an awareness update that describe clients another peer owns. Stock y-websocket clients send
 * every awareness change they see, other people's too, so an echo is normal and must not close the connection.
 */
export function dropForeignAwareness<Peer extends object>(update: Uint8Array, owners: ReadonlyMap<number, Peer>, peer: Peer): Uint8Array {
  readAwarenessClientIds(update)
  const decoder = decoding.createDecoder(update)
  const length = decoding.readVarUint(decoder)
  const kept: Array<[number, number, string]> = []
  for (let index = 0; index < length; index++) {
    const client = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const state = decoding.readVarString(decoder)
    const owner = owners.get(client)
    if (!owner || owner === peer) kept.push([client, clock, state])
  }
  if (kept.length === length) return update
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, kept.length)
  for (const [client, clock, state] of kept) {
    encoding.writeVarUint(encoder, client)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, state)
  }
  return encoding.toUint8Array(encoder)
}

/** Owns peer claims and commits them only after identity binding and quota checks succeed. */
export function createRealtimeAwarenessOwners<Peer extends object>(options: { maxStateBytes?: number } = {}) {
  const owners = new Map<number, Peer>()
  const peerClients = new WeakMap<Peer, Set<number>>()
  return {
    apply(awareness: awarenessProtocol.Awareness, peer: Peer, input: Uint8Array, identity?: RealtimeIdentity): number[] {
      const update = dropForeignAwareness(input, owners, peer)
      const clients = readAwarenessClientIds(update)
      if (!clients.length) return []
      const claimed = claimAwarenessClientIds(owners, peer, clients)
      try {
        const secured = identity ? bindAwarenessIdentity(update, identity) : update
        applyRealtimeAwarenessUpdate(awareness, secured, peer, options.maxStateBytes)
        const ownedClients = peerClients.get(peer) || new Set<number>()
        for (const client of clients) ownedClients.add(client)
        peerClients.set(peer, ownedClients)
        return clients
      }
      catch (error) {
        for (const client of claimed) {
          if (owners.get(client) === peer) owners.delete(client)
        }
        throw error
      }
    },
    release(peer: Peer): number[] {
      const clients = [...peerClients.get(peer) || []]
      peerClients.delete(peer)
      for (const client of clients) {
        if (owners.get(client) === peer) owners.delete(client)
      }
      return clients
    },
  }
}
