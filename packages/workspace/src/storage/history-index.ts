import type { HistoryManifestFile } from "./history-schema.ts"

/** One named head. */
export interface HistoryRefRow {
  ref: string
  head: string | null
  sequence: number
}

/** One stored revision manifest. */
export interface HistoryRevisionRow {
  workspace: string
  id: string
  ref: string
  parentId: string | null
  sequence: number
  createdAt: string
  message: string | null
  metadata: Record<string, unknown> | null
  files: number
  bytes: number
  entries: Record<string, HistoryManifestFile>
  committed: boolean
}

/** One file object to register before its upload. `key` is the digest with a generation suffix. */
export interface HistoryObjectRegistration {
  digest: string
  key: string
  size: number
}

export interface HistoryPublishInput {
  revision: HistoryRevisionRow
  ifHead: string | null
  /** Heads of other refs that must still match. */
  ifHeads: ReadonlyArray<readonly [ref: string, head: string | null]>
  /** The generation keys of the uploaded objects. */
  keys: string[]
  /** False when a needed object has no active generation. The publication then fails. */
  complete: boolean
}

/**
 * The Database side of the Blob + Database Store. Each write is atomic in the Database, so several Store instances on
 * several hosts can share one Workspace. A method that checks a head does the check in the same statement or
 * transaction as the write.
 */
export interface HistoryIndex {
  /** Return the stored identity: the current one, or the legacy one when only that exists. Creates the current one. */
  claim(current: string, legacy: string | undefined): Promise<string>
  /** `undefined` when the identity does not exist. */
  deleted(workspace: string): Promise<boolean | undefined>
  ref(workspace: string, ref: string): Promise<HistoryRefRow | undefined>
  heads(workspace: string): Promise<Array<{ ref: string, revision: HistoryRevisionRow }>>
  revision(workspace: string, id: string): Promise<HistoryRevisionRow | undefined>
  /** Committed revisions of `ref`, newest first. */
  list(workspace: string, query: { ref: string, before?: number, path?: string, limit: number }): Promise<HistoryRevisionRow[]>
  usage(workspace: string): Promise<{ bytes: number, objects: number }>
  /** The generation key of an active object with this digest. */
  objectKey(workspace: string, digest: string): Promise<string | undefined>
  /** Register a generation for each digest that has no active one. Does nothing for a deleted identity. */
  register(workspace: string, objects: HistoryObjectRegistration[]): Promise<void>
  /** The active generation keys of these digests. */
  objectKeys(workspace: string, digests: string[]): Promise<Array<[digest: string, key: string]>>
  hasObject(workspace: string, key: string): Promise<boolean>
  /** Move the head of the ref to the revision. False when a head, the identity, or an object no longer matches. */
  publish(workspace: string, input: HistoryPublishInput): Promise<boolean>
  /** Remove the ref and its revisions, and mark its unshared objects. False when the head is no longer `head`. */
  deleteRef(workspace: string, ref: string, head: string | null): Promise<boolean>
  markedObjects(workspace: string): Promise<string[]>
  dropMarkedObjects(workspace: string, keys: string[]): Promise<void>
  /** Mark the identity deleted and remove its refs. */
  tombstone(workspace: string): Promise<void>
  objects(workspace: string): Promise<string[]>
  /** Remove revisions, objects, and metadata. The tombstone stays. */
  purge(workspace: string): Promise<void>
  getMeta(workspace: string, key: string): Promise<unknown>
  setMeta(workspace: string, key: string, value: unknown): Promise<void>
  deleteMeta(workspace: string, key: string): Promise<void>
}
