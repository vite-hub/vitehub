import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * The caller of a Sync request. `user` and `session` come from ViteHub Auth when the app has it, else they are `null`.
 */
export interface SyncContext {
  request: Request
  user: SyncUser | null
  session: unknown
}

export interface SyncUser {
  id: string
  email?: string | null
  name?: string | null
  [key: string]: unknown
}

/**
 * The rows the caller may see. Return column values that every visible row must have, such as `{ ownerId: user.id }`,
 * `{}` for every row, or `false` to refuse the caller. The server filters reads with these values, writes them into
 * inserts, and refuses writes that would change them.
 */
export type SyncWhere<TRow> = (context: SyncContext) => Partial<TRow> | false | Promise<Partial<TRow> | false>

/** The arguments of a `write` check. `row` is the row after the write, or the deleted row. */
export type SyncWriteContext<TRow> = SyncContext & { op: "insert" | "update" | "delete", row: TRow }

/** Options of `defineSync()`. `TTable` is a Drizzle SQLite table with one text primary key column. */
export interface DefineSyncOptions<TTable, TRow = InferSyncTableRow<TTable>> {
  /** The Drizzle table to sync. */
  table: TTable
  /** The rows the caller may see and write. Required, so that no table is public by mistake. */
  where: SyncWhere<TRow>
  /**
   * Who may write. `true` (the default) lets the caller write every row it can see. `false` makes the table read-only
   * in the browser. A function decides for each write.
   */
  write?: boolean | ((context: SyncWriteContext<TRow>) => boolean | Promise<boolean>)
  /** Checks the whole row on insert and update, on the server. */
  schema?: StandardSchemaV1
  /** The ViteHub Database that holds `table`. Defaults to `"default"`. */
  database?: string
}

/** A Sync definition, the default export of `server/sync/<name>.ts`. */
export interface SyncDefinition<TTable = unknown, TRow = InferSyncTableRow<TTable>> {
  readonly "~sync": true
  readonly options: DefineSyncOptions<TTable, TRow>
  /** Types only. */
  readonly "~row"?: TRow
}

/** The row type of a Drizzle table, from `$inferSelect`. */
export type InferSyncTableRow<TTable> = TTable extends { $inferSelect: infer TRow } ? TRow : Record<string, unknown>

/** The row type of a Sync definition. */
export type InferSyncRow<TDefinition> = TDefinition extends SyncDefinition<unknown, infer TRow> ? TRow : never

declare global {
  /**
   * The Sync definitions of the app, by name. ViteHub writes this map into the generated types as
   * `"todos": typeof import("../server/sync/todos").default`, so `useSync("todos")` knows the row type. Without the
   * generated types, every name is accepted with an untyped row.
   */
  interface ViteHubSyncMap {}
}

/** The row type for a Sync name. */
export type SyncRowOf<TName extends string> = TName extends keyof ViteHubSyncMap ? InferSyncRow<ViteHubSyncMap[TName]> : Record<string, unknown>

/** A Sync name of the app, or any string when the map is empty. */
export type SyncName = keyof ViteHubSyncMap extends never ? string : Extract<keyof ViteHubSyncMap, string>
