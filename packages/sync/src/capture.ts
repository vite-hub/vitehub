import { and, eq, isNull, sql } from "drizzle-orm"

import { syncChanges, syncColumns, syncState } from "./database.ts"

import type { SyncDatabase } from "./database.ts"

/**
 * Change capture. Three triggers on each synced table write the change log, so every write reaches the browsers: Sync
 * pushes and actions, and also server code, jobs, and plain SQL.
 *
 * - After an insert or an update, the `put` of the key is the newest change.
 * - After a delete, an exit `delete` keeps the key and the scope columns of the old row.
 * - After an update that changes a scope column, an exit `move` keeps the old values. A new key is a delete of the old
 *   key.
 *
 * The scope columns are the rows of `vitehub_sync_columns`. The triggers name only them and the key, so a migration
 * can drop any other column.
 */

/** The names of the triggers of a table: insert, update, and delete. */
export function syncTriggerNames(table: string): readonly [string, string, string] {
  return [`vitehub_sync_${table}_insert`, `vitehub_sync_${table}_update`, `vitehub_sync_${table}_delete`]
}

function quote(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Milliseconds since the epoch, in SQL. */
const nowSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

/** A column of the table in the Database, with its declared type. */
interface Column {
  name: string
  type: string
}

/**
 * The key and the scope columns of the old row as a JSON object. A blob or numeric column is text, as `storedValue()`
 * of the handler writes it. Before version 3.48, SQLite allows at most 127 arguments to a function, so a long list is
 * built in parts. `json_patch()` drops the `null` values of a later part, and a missing column reads as `null`.
 */
function oldRowSql(columns: readonly Column[]): string {
  const pairs = columns.map(({ name, type }) => `${literal(name)}, ${/^(?:blob|numeric)/i.test(type) ? `CAST(OLD.${quote(name)} AS text)` : `OLD.${quote(name)}`}`)
  let object = ""
  for (let start = 0; start < pairs.length; start += 60) {
    const part = `json_object(${pairs.slice(start, start + 60).join(", ")})`
    object = object ? `json_patch(${object}, ${part})` : part
  }
  return object
}

/** The `CREATE TRIGGER` statements of a table, in the order of `syncTriggerNames()`. */
function syncTriggerStatements(table: string, key: Column, scope: readonly Column[]): [string, string, string] {
  const [onInsert, onUpdate, onDelete] = syncTriggerNames(table)
  const target = quote(table)
  const name = literal(table)
  const k = quote(key.name)
  const changes = `INSERT INTO "vitehub_sync_changes" ("table_name", "key", "op", "row", "created_at")`
  const dropPut = (row: "NEW" | "OLD") => `DELETE FROM "vitehub_sync_changes" WHERE "table_name" = ${name} AND "key" = ${row}.${k} AND "op" = 'put'`
  const put = `${dropPut("NEW")}; ${changes} VALUES (${name}, NEW.${k}, 'put', NULL, ${nowSql});`
  const old = oldRowSql([key, ...scope])
  const exit = (op: "delete" | "move", condition: string) => `${changes} SELECT ${name}, OLD.${k}, '${op}', ${old}, ${nowSql} WHERE ${condition};`
  const moved = scope.map(column => `OLD.${quote(column.name)} IS NOT NEW.${quote(column.name)}`).join(" OR ")
  const newKey = `OLD.${k} IS NOT NEW.${k}`
  return [
    `CREATE TRIGGER ${quote(onInsert)} AFTER INSERT ON ${target} BEGIN ${put} END`,
    [
      `CREATE TRIGGER ${quote(onUpdate)} AFTER UPDATE ON ${target} BEGIN`,
      exit("delete", newKey),
      `${dropPut("OLD")} AND ${newKey};`,
      // The exit comes before the `put`, so a pull sees that the row is in the new scope after it left the old one.
      ...moved ? [exit("move", `OLD.${k} IS NEW.${k} AND (${moved})`)] : [],
      put,
      "END",
    ].join(" "),
    `CREATE TRIGGER ${quote(onDelete)} AFTER DELETE ON ${target} BEGIN ${dropPut("OLD")}; ${exit("delete", "1")} END`,
  ]
}

/** For each `SyncServices.db` and table, the scope columns that the triggers of the table have in this process. */
const installed = new WeakMap<object, Map<string, Set<string>>>()

/** Attempts of an install whose read went old because another process registered a column at the same time. */
const maxAttempts = 3

/**
 * Registers the scope columns `columns` (SQL names) of a table, and makes its triggers name the key and every
 * registered column that the table has. Runs before Sync answers a request, so no browser holds rows before their
 * scope columns are in the triggers. Each process checks once for each table and new column: `owner` is the `db` of
 * the `SyncServices`, which stays the same for every request.
 *
 * Triggers that were missing on a table with a change log, such as after a migration rebuilt the table, missed writes:
 * the install raises the floor, so every client with a cursor gets a full snapshot.
 */
export async function captureChanges(owner: object, db: SyncDatabase, table: string, key: string, columns: readonly string[]): Promise<void> {
  let tables = installed.get(owner)
  if (!tables) installed.set(owner, tables = new Map())
  const done = tables.get(table)
  if (done && columns.every(column => column === key || done.has(column))) return
  const names = syncTriggerNames(table)
  for (let attempt = 1; ; attempt++) {
    const [, registered, shape, existing, history] = await db.batch([
      db.run(sql`INSERT OR IGNORE INTO ${syncColumns} (${sql.identifier("table_name")}, ${sql.identifier("column")}) SELECT ${table}, value FROM json_each(${JSON.stringify(columns)})`),
      db.select({ column: syncColumns.column }).from(syncColumns).where(eq(syncColumns.tableName, table)),
      db.all<Column>(sql`SELECT name, type FROM pragma_table_info(${table})`),
      // Every trigger of Sync on the table, also one of an older name, such as before the table was renamed.
      db.all<{ name: string, sql: string }>(sql`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ${table} AND name LIKE 'vitehub\\_sync\\_%' ESCAPE '\\'`),
      db.all<{ seen: number }>(sql`SELECT EXISTS (SELECT 1 FROM ${syncChanges} WHERE ${syncChanges.tableName} = ${table}) OR EXISTS (SELECT 1 FROM ${syncState} WHERE ${syncState.tableName} = ${table}) AS seen`),
    ])
    const types = new Map(shape.map(column => [column.name, column.type]))
    // A registered column that the table does not have yet, such as before its migration, stays out of the triggers.
    const scope = registered.map(row => row.column).filter(column => column !== key && types.has(column)).sort()
    const wanted = syncTriggerStatements(table, { name: key, type: types.get(key) ?? "text" }, scope.map(column => ({ name: column, type: types.get(column) ?? "" })))
    const current = new Map(existing.map(trigger => [trigger.name, trigger.sql]))
    if (existing.length === names.length && names.every((name, index) => current.get(name) === wanted[index])) {
      tables.set(table, new Set(scope))
      return
    }
    const missed = names.some(name => !current.has(name)) && history[0]?.seen === 1
    try {
      await db.batch([
        // Fails the batch when another process registered a column after the read above, so its column stays in the
        // triggers: the install then reads again.
        db.run(sql`INSERT INTO ${syncColumns} (${sql.identifier("table_name")}, ${sql.identifier("column")}) SELECT ${table}, NULL WHERE (SELECT count(*) FROM ${syncColumns} WHERE ${syncColumns.tableName} = ${table}) <> ${registered.length}`),
        ...existing.map(trigger => db.run(sql.raw(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`))),
        ...wanted.map(statement => db.run(sql.raw(statement))),
        ...missed ? raiseFloor(db, table) : [],
      ])
      tables.set(table, new Set(scope))
      return
    }
    catch (error) {
      if (attempt >= maxAttempts) throw error
    }
  }
}

/**
 * Raises the floor of a table above every cursor that a client holds. A marker change takes the next `seq`, the floor
 * becomes that `seq`, and the marker goes. `AUTOINCREMENT` never gives the `seq` again, so later changes are above the
 * floor.
 */
function raiseFloor(db: SyncDatabase, table: string) {
  const marker = and(eq(syncChanges.tableName, table), eq(syncChanges.key, ""), eq(syncChanges.op, "move"), isNull(syncChanges.row))
  return [
    db.run(sql`INSERT INTO ${syncChanges} (${sql.identifier("table_name")}, ${sql.identifier("key")}, ${sql.identifier("op")}, ${sql.identifier("row")}, ${sql.identifier("created_at")}) VALUES (${table}, '', 'move', NULL, ${sql.raw(nowSql)})`),
    db.run(sql`INSERT INTO ${syncState} (${sql.identifier("table_name")}, ${sql.identifier("floor")}) SELECT ${table}, max(${syncChanges.seq}) FROM ${syncChanges} WHERE ${marker} ON CONFLICT (${sql.identifier("table_name")}) DO UPDATE SET ${sql.identifier("floor")} = max(${sql.identifier("floor")}, excluded.${sql.identifier("floor")})`),
    db.delete(syncChanges).where(marker),
  ]
}
