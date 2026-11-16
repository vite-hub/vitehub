import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"

/**
 * What one instance tells the other instances about a room:
 * - `update`: a Yjs update of the room document.
 * - `awareness`: an awareness update of the room's clients.
 * - `claim`: the connection-time awareness client id of a peer; retires that client's old socket ownership.
 * - `sync`: an instance opened the room and asks for what it lacks. `data` is its Yjs state vector.
 * - `reset`: the room re-seeded at `epoch`. Instances at another epoch load the room again.
 * - `refresh`: `refreshRealtimeDocument()` ran on an instance.
 * - `frame`: a protocol frame to relay to every peer as it is, such as a Workspace change.
 */
export const realtimeBusMessageTypes = Object.freeze({ update: 0, awareness: 1, sync: 2, reset: 3, refresh: 4, frame: 5, claim: 6 } as const)

export type RealtimeBusMessageType = keyof typeof realtimeBusMessageTypes

export interface RealtimeBusMessage {
  type: RealtimeBusMessageType
  /** The instance that sent the message. An instance ignores its own messages. */
  instance: string
  /** The room key, `realtimeRoomKey()` for documents. */
  room: string
  /** The room epoch of the sender. Instances at another epoch ignore document and awareness updates; mismatched `sync` requests repair the epoch. */
  epoch: string
  data: Uint8Array
}

/** The shared copy of a room: the Yjs state at a stored document digest. Instances that open the room start from it. */
export interface RealtimeRoomRecord {
  epoch: string
  digest: string | null
  state: Uint8Array
  /** The state submitted to a save that may have completed before its digest could be recorded. */
  pending?: boolean
}

/**
 * Connects the rooms of several server instances. Each instance keeps its own room in memory. The bus carries room
 * traffic between instances, and keeps one shared record of each room so that every instance starts from the same Yjs
 * history.
 */
export interface RealtimeBus {
  readonly authority: "postgres" | "redis"
  /** The id of this instance in bus messages. */
  readonly instance: string
  /** Sends a message to the other instances. */
  publish(message: Omit<RealtimeBusMessage, "instance">): Promise<void>
  /**
   * Delivers the messages of the other instances in order. `resubscribed` runs after the connection came back, because
   * the bus can lose messages while it is down.
   */
  subscribe(listener: (message: RealtimeBusMessage) => void | Promise<void>, resubscribed?: () => void): Promise<void>
  readRoom(room: string): Promise<RealtimeRoomRecord | undefined>
  /** Writes the record only when the stored epoch is `ifEpoch`, or when there is no record for `null`. Resolves whether it wrote. */
  writeRoom(room: string, record: RealtimeRoomRecord, ifEpoch: string | null): Promise<boolean>
  /** Runs `task` while this instance holds the save lock of the room. Saves of one room run one at a time across instances. */
  withRoomLock<T>(room: string, task: () => Promise<T>): Promise<T>
  /** Runs before the bus closes, such as to remove this instance's presence from the other instances. */
  onClose(hook: () => Promise<void>): void
  close(): Promise<void>
}

const envelopeVersion = 1

export function encodeRealtimeBusMessage(message: RealtimeBusMessage): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, envelopeVersion)
  encoding.writeVarUint(encoder, realtimeBusMessageTypes[message.type])
  encoding.writeVarString(encoder, message.instance)
  encoding.writeVarString(encoder, message.room)
  encoding.writeVarString(encoder, message.epoch)
  encoding.writeVarUint8Array(encoder, message.data)
  return encoding.toUint8Array(encoder)
}

const typesByCode = new Map<number, RealtimeBusMessageType>(
  // SAFETY: the keys of `realtimeBusMessageTypes` are exactly the message types.
  Object.entries(realtimeBusMessageTypes).map(([type, code]) => [code, type as RealtimeBusMessageType]),
)

/** Reads a bus message, or `undefined` when it is not one of this version. */
export function decodeRealtimeBusMessage(bytes: Uint8Array): RealtimeBusMessage | undefined {
  try {
    const decoder = decoding.createDecoder(bytes)
    if (decoding.readVarUint(decoder) !== envelopeVersion) return
    const type = typesByCode.get(decoding.readVarUint(decoder))
    if (!type) return
    const instance = decoding.readVarString(decoder)
    const room = decoding.readVarString(decoder)
    const epoch = decoding.readVarString(decoder)
    const data = decoding.readVarUint8Array(decoder)
    return { type, instance, room, epoch, data }
  }
  catch {
    return undefined
  }
}
