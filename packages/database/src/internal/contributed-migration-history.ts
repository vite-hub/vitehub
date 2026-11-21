import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

import { join } from "pathe"

import { listD1Migrations } from "./d1-migrations.ts"

type MigratedTables = Map<string, Set<string>>
type MigrationHistory = { migrationsDir: string, missingSql: string[], order: Array<string | undefined> }

export function sqliteIdentifier(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase())
}

export function migrationTableKey(table: string, schema?: string): string {
  return schema === undefined ? sqliteIdentifier(table) : JSON.stringify([schema, table])
}

export function readContributedMigrationHistory(migrationsDir: string, d1: boolean): MigrationHistory {
  const entries = existsSync(migrationsDir) ? readdirSync(migrationsDir, { withFileTypes: true }) : []
  const folders: string[] = []
  const missingSql: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sql = join(migrationsDir, entry.name, "migration.sql")
    if (statSync(sql, { throwIfNoEntry: false })?.isFile()) folders.push(entry.name)
    else if (/^\d{14}_/.test(entry.name) || existsSync(join(migrationsDir, entry.name, "snapshot.json"))) missingSql.push(sql)
  }
  folders.sort((left, right) => left.localeCompare(right))
  const order = d1 && !missingSql.length
    ? listD1Migrations(migrationsDir).map(file => file.source === join(migrationsDir, file.name) ? undefined : file.tag)
    : [...folders, ...(entries.some(entry => entry.isFile() && entry.name.endsWith(".sql")) ? [undefined] : [])]
  return { migrationsDir, missingSql, order }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function snapshotAt(dir: string, tag: string): Record<string, unknown> | undefined {
  try {
    const snapshot: unknown = JSON.parse(readFileSync(join(dir, tag, "snapshot.json"), "utf8"))
    if (isRecord(snapshot)) return snapshot
  }
  catch {
    return undefined
  }
}

function tableColumns(ddl: readonly unknown[], postgres: boolean): MigratedTables {
  const tables: MigratedTables = new Map()
  for (const entity of ddl) {
    if (!isRecord(entity) || typeof entity.name !== "string") continue
    const name = entity.entityType === "tables" ? entity.name : entity.entityType === "columns" ? entity.table : undefined
    if (typeof name !== "string") continue
    const key = migrationTableKey(name, postgres && typeof entity.schema === "string" ? entity.schema : postgres ? "public" : undefined)
    const columns = tables.get(key) ?? new Set<string>()
    if (entity.entityType === "columns") columns.add(postgres ? entity.name : sqliteIdentifier(entity.name))
    tables.set(key, columns)
  }
  return tables
}

function sqliteTables(snapshots: readonly Record<string, unknown>[]): MigratedTables | undefined {
  const origin = "00000000-0000-0000-0000-000000000000"
  const empty = { ddl: "[]", tables: new Map<string, Set<string>>() }
  const states = new Map([[origin, empty]])
  const applied: MigratedTables = new Map()
  for (const snapshot of snapshots) {
    if (snapshot.dialect !== "sqlite" || typeof snapshot.id !== "string" || !Array.isArray(snapshot.ddl)
      || !Array.isArray(snapshot.prevIds) || snapshot.prevIds.length !== 1 || typeof snapshot.prevIds[0] !== "string") return
    const parent = states.get(snapshot.prevIds[0])
    const ddl = JSON.stringify(snapshot.ddl)
    if (!parent || parent.ddl === ddl) return
    const tables = tableColumns(snapshot.ddl, false)
    for (const [table, previous] of parent.tables) {
      const next = tables.get(table)
      if (!next) applied.delete(table)
      else for (const column of previous) if (!next.has(column)) applied.get(table)?.delete(column)
    }
    for (const [table, next] of tables) {
      const previous = parent.tables.get(table)
      const columns = applied.get(table) ?? new Set<string>()
      for (const column of next) if (!previous?.has(column)) columns.add(column)
      applied.set(table, columns)
    }
    states.set(snapshot.id, { ddl, tables })
  }
  return applied
}

/** Reads generated schema history only. Custom SQL with no corresponding DDL changes leaves the schema unknown. */
export async function readMigratedTables(history: MigrationHistory, contributed: ReadonlySet<string>, postgres: boolean): Promise<MigratedTables | undefined> {
  const tags = history.order.filter(tag => tag === undefined || !contributed.has(tag))
  if (tags.length && tags.at(-1) === undefined) return
  const snapshots: Record<string, Record<string, unknown>> = Object.create(null)
  for (const tag of tags) {
    if (tag === undefined) continue
    const snapshot = snapshotAt(history.migrationsDir, tag)
    if (!snapshot) return
    snapshots[tag] = snapshot
  }
  const ordered = Object.values(snapshots)
  if (!ordered.length) return new Map()
  if (!postgres) return sqliteTables(ordered)
  if (ordered.some(snapshot => snapshot.type === "diff" ? !Array.isArray(snapshot.deltas) || !snapshot.deltas.length : !Array.isArray(snapshot.ddl) || !snapshot.ddl.length)) return
  try {
    const { reconstruct } = await import("drizzle-kit/api-postgres")
    return tableColumns((await reconstruct(snapshots)).ddl, true)
  }
  catch {
    return undefined
  }
}
