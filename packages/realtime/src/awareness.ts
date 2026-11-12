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

/**
 * Records that `peer` owns `clients`. A client that another peer owns is a conflict, unless `transferable` accepts its
 * owner, such as another server instance that the client left.
 */
export function claimAwarenessClientIds<Peer extends object>(
  owners: Map<number, Peer>,
  peer: Peer,
  clients: number[],
  transferable: (owner: Peer) => boolean = () => false,
): number[] {
  for (const client of clients) {
    const owner = owners.get(client)
    if (owner && owner !== peer && !transferable(owner)) throw new AwarenessOwnershipConflict()
  }
  const ownedClients = new Set(
    [...owners].filter(([, owner]) => owner === peer).map(([client]) => client),
  )
  for (const client of clients) ownedClients.add(client)
  if (ownedClients.size > maxAwarenessClients) {
    throw realtimeErrorDiagnostics.REALTIME_TOO_MANY_AWARENESS_CLIENTS()
  }
  const claimed = clients.filter(client => !owners.has(client))
  for (const client of clients) owners.set(client, peer)
  return claimed
}

export class AwarenessOwnershipConflict extends Diagnostic {
  constructor() {
    const { code, docs, fix, why } = realtimeErrorDiagnostics.REALTIME_AWARENESS_OWNERSHIP_CONFLICT()
    super({ code, docs, fix, why }, AwarenessOwnershipConflict)
    this.name = "AwarenessOwnershipConflict"
  }
}

export function bindAwarenessIdentity(update: Uint8Array, identity: RealtimeIdentity): Uint8Array {
  return awarenessProtocol.modifyAwarenessUpdate(update, (state: unknown) => {
    if (state === null) return null
    if (!isPlainObject(state)) throw realtimeErrorDiagnostics.REALTIME_INVALID_AWARENESS()
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
  if (stateBytes > maxStateBytes) throw realtimeErrorDiagnostics.REALTIME_AWARENESS_TOO_LARGE()
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
function dropForeignAwareness<Peer extends object>(
  update: Uint8Array,
  owners: ReadonlyMap<number, Peer>,
  peer: Peer,
  awareness: awarenessProtocol.Awareness,
): Uint8Array {
  const decoder = decoding.createDecoder(update)
  const length = decoding.readVarUint(decoder)
  if (length > maxAwarenessClients) throw realtimeErrorDiagnostics.REALTIME_TOO_MANY_AWARENESS_CLIENTS({})
  const kept: Array<[number, number, string]> = []
  for (let index = 0; index < length; index++) {
    const client = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const state = decoding.readVarString(decoder)
    const owner = owners.get(client)
    // Neither a newer clock nor a null state proves ownership: a stock client can echo either over BroadcastChannel.
    if (owner === peer || (!owner && state.trim() !== "null" && clock > (awareness.meta.get(client)?.clock ?? -1))) kept.push([client, clock, state])
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

/**
 * Owns peer claims and commits them only after identity binding and quota checks succeed. With several server
 * instances, an object that stands for another instance owns the clients of that instance's peers: `apply()` with
 * `remote: true` records them. Ownership handoff is explicit through `claim()`, independent of awareness clocks.
 * Awareness payloads never transfer an existing claim or claim a client from a null echo.
 */
export function createRealtimeAwarenessOwners<Peer extends object>(options: { maxStateBytes?: number } = {}) {
  const owners = new Map<number, Peer>()
  const peerClients = new WeakMap<Peer, Set<number>>()
  const remoteOwners = new WeakSet<Peer>()
  const transferable = (owner: Peer) => remoteOwners.has(owner)
  function disown(client: number, owner: Peer) {
    owners.delete(client)
    peerClients.get(owner)?.delete(client)
  }
  return {
    /** A WebSocket declares its own client id at connection time; the bus relays that claim to retire the old socket. */
    claim(awareness: awarenessProtocol.Awareness, peer: Peer, client: number, identity?: RealtimeIdentity, remote = false): boolean {
      const state = awareness.getStates().get(client)
      if (!remote && identity && state && (!isPlainObject(state.user) || state.user.id !== identity.id)) return false
      if (remote) remoteOwners.add(peer)
      const owner = owners.get(client)
      if (owner && owner !== peer) disown(client, owner)
      claimAwarenessClientIds(owners, peer, [client])
      const clients = peerClients.get(peer) || new Set<number>()
      clients.add(client)
      peerClients.set(peer, clients)
      return true
    },
    apply(awareness: awarenessProtocol.Awareness, peer: Peer, input: Uint8Array, identity?: RealtimeIdentity, remote = false): number[] {
      if (remote) remoteOwners.add(peer)
      const update = dropForeignAwareness(input, owners, peer, awareness)
      const clients = readAwarenessClientIds(update)
      if (!clients.length) return []
      const previous = new Map(clients.flatMap(client => {
        const owner = owners.get(client)
        return owner && owner !== peer ? [[client, owner] as const] : []
      }))
      const claimed = claimAwarenessClientIds(owners, peer, clients, transferable)
      try {
        const secured = identity ? bindAwarenessIdentity(update, identity) : update
        applyRealtimeAwarenessUpdate(awareness, secured, peer, options.maxStateBytes)
        for (const [client, owner] of previous) peerClients.get(owner)?.delete(client)
        const ownedClients = peerClients.get(peer) || new Set<number>()
        for (const client of clients) ownedClients.add(client)
        peerClients.set(peer, ownedClients)
        return clients
      }
      catch (error) {
        for (const client of claimed) {
          if (owners.get(client) === peer) owners.delete(client)
        }
        for (const [client, owner] of previous) owners.set(client, owner)
        throw error
      }
    },
    /** Whether a peer of this instance owns the client. */
    ownsLocally(client: number): boolean {
      const owner = owners.get(client)
      return !!owner && !remoteOwners.has(owner)
    },
    release(peer: Peer): number[] {
      const clients = [...peerClients.get(peer) || []]
      peerClients.delete(peer)
      for (const client of clients) {
        if (owners.get(client) === peer) owners.delete(client)
      }
      return clients
    },
    /** Forgets the clients that another instance owned, after their state was removed. */
    releaseRemote(clients: readonly number[]): void {
      for (const client of clients) {
        const owner = owners.get(client)
        if (owner && remoteOwners.has(owner)) disown(client, owner)
      }
    },
  }
}
