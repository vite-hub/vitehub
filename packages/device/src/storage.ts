/** The account and the version that every stored copy belongs to. One device holds one account. */
export interface DeviceMeta {
  account: string | null
  version: string
  /**
   * A new id each time the copies on the disk start over: another account, another version, or a clear. A write
   * applies only when the disk still has the generation that the tab expects, so a tab that missed a change cannot
   * fill the disk again.
   */
  generation: string
}

/** One stored answer. `json` is the value as JSON, so equal answers compare as strings and nothing shares a reference. */
export interface StoredEntry {
  key: string
  json: string
  /** When the answer was stored, in milliseconds since the epoch. */
  storedAt: number
  /** After this time, the disk deletes the copy. */
  expiresAt: number
  /** The size of `json` in UTF-8. */
  bytes: number
}

/** One write to the disk. */
export interface DeviceChange {
  puts: StoredEntry[]
  deletes: string[]
  /**
   * After the change, the disk deletes the copies that expired at `now`, then its oldest copies, also copies of other
   * tabs, until it holds at most `maxBytes`. It picks them from what it holds, in the same transaction.
   */
  maxBytes: number
  now: number
}

/** Where the device keeps its copies across reloads. The browser uses IndexedDB, and the tests use a fake. */
export interface DeviceStorage {
  read: () => Promise<{ meta: DeviceMeta | undefined, entries: StoredEntry[] }>
  /** Deletes every copy and stores `meta`. */
  reset: (meta: DeviceMeta) => Promise<void>
  /**
   * Applies `change` in one transaction when the disk still has `meta`. Returns the meta that the disk had: the change
   * applied when it has the generation of `meta`, and changed nothing otherwise.
   */
  write: (meta: DeviceMeta, change: DeviceChange) => Promise<DeviceMeta | undefined>
  /** Deletes every copy and gives the disk `generation`. The account and the version stay. Returns the new meta. */
  clear: (generation: string) => Promise<DeviceMeta | undefined>
  close: () => void
}

/**
 * A message between the tabs of one browser. `meta` is the meta of the disk after the change, or `undefined` when the
 * disk did not change, such as in a tab without IndexedDB.
 */
export type DeviceMessage
  = | { type: "clear", meta: DeviceMeta | undefined }
    /** A tab named `account`. */
    | { type: "account", account: string | null, meta: DeviceMeta | undefined }

/** How tabs talk. The browser uses a BroadcastChannel, and the tests use a fake. */
export interface DeviceChannel {
  post: (message: DeviceMessage) => void
  receive: (listener: (message: DeviceMessage) => void) => () => void
}
