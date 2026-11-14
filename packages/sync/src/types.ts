import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { SyncKey } from "./protocol.ts"

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
 * Column values that every visible row has. A single value matches the column. An array matches any of its values, such
 * as the teams of the caller: `{ teamId: user.teamIds }`.
 */
export type SyncWhereValues<TRow> = { [TColumn in keyof TRow]?: TRow[TColumn] | readonly TRow[TColumn][] }

/**
 * The rows the caller may see. Return column values that every visible row must have, such as `{ ownerId: user.id }`
 * or `{ teamId: teamIds }`, `{}` for every row, or `false` to refuse the caller. The server filters reads with these
 * values, writes the single values into inserts, and refuses writes that would leave them.
 */
export type SyncWhere<TRow> = (context: SyncContext) => SyncWhereValues<TRow> | false | Promise<SyncWhereValues<TRow> | false>

/** The arguments of a `write` check. `row` is the row after the write, or the deleted row. */
export type SyncWriteContext<TRow> = SyncContext & { op: "insert" | "update" | "delete", row: TRow }

/**
 * What an action gets. The writes run with the same rules as writes from the browser (`where`, `write`, `schema`), and
 * they are applied together, in one atomic batch, after the action returns. Reads with `get()` see the table before the
 * action's writes.
 */
export interface SyncActionContext<TRow> extends SyncContext {
  /** The row with this key, when the caller may see it. */
  get: (key: SyncKey) => Promise<TRow | undefined>
  /** Adds a row and returns its key. Pass the key in `value` when the client made it, so the optimistic row keeps it. */
  insert: (value: Partial<TRow>) => SyncKey
  update: (key: SyncKey, patch: Partial<TRow>) => void
  delete: (key: SyncKey) => void
}

/**
 * A named write that runs on the server, such as `complete` or `rate`. Annotate `args`, so the browser call is typed:
 * `complete: async ({ update }, { id }: { id: string }) => update(id, { done: true })`. `args` come from the browser:
 * check them before you trust them, such as with `v.parse()`. Throw to refuse the action: the browser gets
 * `SYNC_ACTION_REFUSED`. A JSON return value reaches the browser as the result of the call.
 */
export type SyncActionFunction<TRow, TArgs> = (context: SyncActionContext<TRow>, args: TArgs) => unknown

/** The actions of a definition, by name. `TArgs` maps each action name to the type of its arguments. */
export type SyncActions<TRow, TArgs> = { [TName in keyof TArgs]: SyncActionFunction<TRow, TArgs[TName]> }

/** Options of `defineSync()`. `TTable` is a Drizzle SQLite table with one text primary key column. */
export interface DefineSyncOptions<TTable, TRow = InferSyncTableRow<TTable>, TArgs = Record<string, never>> {
  /** The Drizzle table to sync. */
  table: TTable
  /** The rows the caller may see and write. Required, so that no table is public by mistake. */
  where: SyncWhere<TRow>
  /**
   * Who may write. `true` (the default) lets the caller write every row it can see. `false` makes the table read-only
   * in the browser; actions still run. A function decides for each write.
   */
  write?: boolean | ((context: SyncWriteContext<TRow>) => boolean | Promise<boolean>)
  /** Checks the whole row on insert and update, on the server. */
  schema?: StandardSchemaV1
  /**
   * The columns that a browser may load a subset by, such as `["issueId"]` for
   * `useSync("comments", { where: { issueId } })`. A subset on another column is refused with `SYNC_BAD_REQUEST`, unless
   * `where` sets that column. When a write changes one of these columns, the row leaves the subsets that held it. Add an
   * index on each of these columns.
   *
   * @experimental
   */
  subsets?: readonly (keyof TRow & string)[]
  /**
   * The caller's own account. Return the caller's user id when the app has its own sign-in, not ViteHub Auth. Queued
   * writes belong to the account, and the server refuses writes of another account with `SYNC_SCOPE_CHANGED`. Without
   * this option, the account is `user.id` from ViteHub Auth, else the scope of `where`, which changes when the caller
   * joins or leaves a team. Return `null` for a caller without an account: the scope is then the account.
   *
   * @experimental
   */
  account?: (context: SyncContext) => string | null | Promise<string | null>
  /** Named writes with server logic, called from the browser as `todos.actions.<name>(args)`. */
  actions?: SyncActions<TRow, TArgs>
  /**
   * `true` (the default) lets browsers keep a live stream open, so changes show within a second. `false` leaves only
   * pulls on focus, on reconnect, on a timer and after writes.
   */
  live?: boolean
  /** The ViteHub Database that holds `table`. Defaults to `"default"`. */
  database?: string
}

/** A Sync definition, the default export of `server/sync/<name>.ts`. */
export interface SyncDefinition<TTable = unknown, TRow = InferSyncTableRow<TTable>, TArgs = Record<string, never>> {
  readonly "~sync": true
  readonly options: DefineSyncOptions<TTable, TRow, TArgs>
  /** Types only. */
  readonly "~row"?: TRow
  /** Types only: the arguments of each action, by name. */
  readonly "~actions"?: TArgs
}

/** The row type of a Drizzle table, from `$inferSelect`. */
export type InferSyncTableRow<TTable> = TTable extends { $inferSelect: infer TRow } ? TRow : Record<string, unknown>

/** The row type of a Sync definition. */
export type InferSyncRow<TDefinition> = TDefinition extends { "~row"?: infer TRow } ? Exclude<TRow, undefined> : never

/** The arguments of each action of a Sync definition, by action name. */
export type InferSyncActions<TDefinition> = TDefinition extends { "~actions"?: infer TArgs } ? Exclude<TArgs, undefined> : never

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

/** The arguments of each action for a Sync name, by action name. Without the generated types, no action is known. */
export type SyncActionsOf<TName extends string> = TName extends keyof ViteHubSyncMap ? InferSyncActions<ViteHubSyncMap[TName]> : Record<string, never>

/** A Sync name of the app, or any string when the map is empty. */
export type SyncName = keyof ViteHubSyncMap extends never ? string : Extract<keyof ViteHubSyncMap, string>
