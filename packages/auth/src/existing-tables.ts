// The Auth tables that a SQLite Database has already, read from the Drizzle snapshot of its latest migration. An app that
// moves its own Better Auth tables to `authDatabase()` keeps them as they are where a change needs a SQLite table rebuild
// and Better Auth does not need the change. A rebuild drops the old table, and D1 and libSQL then run the ON DELETE
// actions of every table that references it, so the rows of the app that reference `user` or `organization` go too.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface AuthExistingColumn {
  notNull: boolean
  /** The SQL text of the column default, such as `'member'` or `(cast(unixepoch('subsecond') * 1000 as integer))`. */
  default?: string
}

export interface AuthExistingIndex {
  name: string
  columns: readonly string[]
  unique: boolean
}

export interface AuthExistingForeignKey {
  /** The name, when the schema named the foreign key. Drizzle Kit derives the others from the columns. */
  name?: string
  columns: readonly string[]
  tableTo: string
  columnsTo: readonly string[]
  onDelete: string
  onUpdate: string
}

export interface AuthExistingUnique {
  name?: string
  columns: readonly string[]
}

/** One table of the snapshot, by SQL column name. */
export interface AuthExistingTable {
  columns: Readonly<Record<string, AuthExistingColumn>>
  indexes: readonly AuthExistingIndex[]
  uniques: readonly AuthExistingUnique[]
  foreignKeys: readonly AuthExistingForeignKey[]
}

/** The existing tables, by SQL table name. */
export type AuthExistingTables = Readonly<Record<string, AuthExistingTable>>

interface SnapshotEntity {
  entityType?: unknown
  table?: unknown
  name?: unknown
  notNull?: unknown
  default?: unknown
  columns?: unknown
  isUnique?: unknown
  tableTo?: unknown
  columnsTo?: unknown
  onDelete?: unknown
  onUpdate?: unknown
  nameExplicit?: unknown
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** The snapshot of the newest migration folder, which Drizzle Kit compares the schema with. */
function latestSnapshot(migrationsDir: string): SnapshotEntity[] | undefined {
  if (!existsSync(migrationsDir)) return
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "snapshot.json")))
    .map(entry => entry.name)
    .sort()
  const latest = folders.at(-1)
  if (!latest) return
  const snapshot = JSON.parse(readFileSync(join(migrationsDir, latest, "snapshot.json"), "utf8")) as { dialect?: unknown, ddl?: unknown }
  return snapshot.dialect === "sqlite" && Array.isArray(snapshot.ddl) ? snapshot.ddl as SnapshotEntity[] : undefined
}

/**
 * Reads the tables of `tableNames` from the latest migration snapshot in `migrationsDir`. Returns `undefined` when the
 * folder has no SQLite snapshot, and leaves out the tables that the snapshot does not have.
 */
export function readAuthExistingTables(migrationsDir: string, tableNames: readonly string[]): AuthExistingTables | undefined {
  const ddl = latestSnapshot(migrationsDir)
  if (!ddl) return
  const wanted = new Set(tableNames)
  const tables: Record<string, { columns: Record<string, AuthExistingColumn>, indexes: AuthExistingIndex[], uniques: AuthExistingUnique[], foreignKeys: AuthExistingForeignKey[] }> = {}
  const table = (name: string) => tables[name] ??= { columns: {}, indexes: [], uniques: [], foreignKeys: [] }
  for (const entity of ddl) {
    if (entity.entityType === "tables" && typeof entity.name === "string" && wanted.has(entity.name)) table(entity.name)
  }
  for (const entity of ddl) {
    if (typeof entity.table !== "string" || typeof entity.name !== "string" || !Object.hasOwn(tables, entity.table)) continue
    const target = tables[entity.table]!
    if (entity.entityType === "columns") {
      target.columns[entity.name] = { notNull: entity.notNull === true, ...(typeof entity.default === "string" ? { default: entity.default } : {}) }
    }
    else if (entity.entityType === "indexes" && Array.isArray(entity.columns)) {
      const columns = entity.columns.map(column => (column as { value?: unknown, isExpression?: unknown }))
      // An expression index cannot match a Better Auth column.
      if (columns.some(column => column.isExpression === true || typeof column.value !== "string")) continue
      target.indexes.push({ name: entity.name, columns: columns.map(column => column.value as string), unique: entity.isUnique === true })
    }
    else if (entity.entityType === "uniques") {
      target.uniques.push({ ...(entity.nameExplicit === true ? { name: entity.name } : {}), columns: strings(entity.columns) })
    }
    else if (entity.entityType === "fks" && typeof entity.tableTo === "string") {
      target.foreignKeys.push({
        ...(entity.nameExplicit === true ? { name: entity.name } : {}),
        columns: strings(entity.columns),
        tableTo: entity.tableTo,
        columnsTo: strings(entity.columnsTo),
        onDelete: typeof entity.onDelete === "string" ? entity.onDelete : "NO ACTION",
        onUpdate: typeof entity.onUpdate === "string" ? entity.onUpdate : "NO ACTION",
      })
    }
  }
  return tables
}
