/** The account and the version that every stored copy belongs to. One device holds one account. */
export interface DeviceMeta {
  account: string | null
  version: string
}

/** One stored answer. `json` is the value as JSON, so equal answers compare as strings and nothing shares a reference. */
export interface StoredEntry {
  key: string
  json: string
  /** When the answer was stored, in milliseconds since the epoch. */
  storedAt: number
  /** After this time, the next `openDevice()` deletes the copy. */
  expiresAt: number
  /** The size of `json` in UTF-8. */
  bytes: number
}

/** Where the device keeps its copies across reloads. The browser uses IndexedDB, and the tests use a fake. */
export interface DeviceStorage {
  read: () => Promise<{ meta: DeviceMeta | undefined, entries: StoredEntry[] }>
  /** Deletes every copy and stores `meta`. */
  reset: (meta: DeviceMeta) => Promise<void>
  /**
   * Stores `puts` and deletes `deletes` in one change, when the stored meta is still `meta`. Returns `false` and changes
   * nothing when another tab changed the account or the version meanwhile.
   */
  write: (meta: DeviceMeta, puts: StoredEntry[], deletes: string[]) => Promise<boolean>
  /** Deletes every copy and keeps the meta. */
  clear: () => Promise<void>
  close: () => void
}

/** A message between the tabs of one browser. */
export type DeviceMessage
  = | { type: "clear" }
    | { type: "account", account: string | null, version: string }

/** How tabs talk. The browser uses a BroadcastChannel, and the tests use a fake. */
export interface DeviceChannel {
  post: (message: DeviceMessage) => void
  receive: (listener: (message: DeviceMessage) => void) => () => void
}
