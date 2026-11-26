import { isPlainObject } from "@vite-hub/internal/object"

/** An entity of a Drizzle Kit 1.0 SQLite snapshot, such as a table, a column, an index, or a UNIQUE constraint. */
interface SqliteDdlEntity {
  entityType: string
  table?: string
  name?: string
  columns?: unknown[]
  isUnique?: boolean
  where?: unknown
}

export interface SqliteSnapshot {
  ddl: SqliteDdlEntity[]
}

/** The column names of an index or constraint. Undefined when one of them is an expression. */
function columnNames(entity: { columns?: unknown[] }): string[] | undefined {
  const names: string[] = []
  for (const column of entity.columns ?? []) {
    if (typeof column === "string") names.push(column)
    else if (typeof column === "object" && column !== null && "value" in column && typeof column.value === "string" && !("isExpression" in column && column.isExpression)) names.push(column.value)
    else return undefined
  }
  return names.length ? names : undefined
}

/**
 * Reports whether a snapshot has a unique index with the name that Drizzle Kit 0.x gave a `.unique()` column, such as
 * `user_email_unique`. Folders that `drizzle-kit up` converted without `recordUniqueIndexesAsConstraints()` keep them.
 */
export function hasKit0UniqueIndexes(snapshot: SqliteSnapshot): boolean {
  return snapshot.ddl.some(entity => entity.entityType === "indexes" && entity.isUnique === true && entity.where == null && entity.name?.endsWith("_unique"))
}

function key(table: string | undefined, columns: string[]): string {
  return JSON.stringify([table, columns])
}

/**
 * Drizzle Kit 0.x wrote a SQLite `.unique()` column as a unique index, and Drizzle Kit 1.0 writes it as a UNIQUE
 * constraint. `drizzle-kit up` keeps the index in the converted snapshots, so the next `generate` rebuilds each of these
 * tables to replace the index with the constraint. This records each unique index as the UNIQUE constraint that the
 * current schema declares on the same table and columns. Both reject the same rows, so the database needs no change.
 * An index that the schema still declares as an index stays. Returns the number of indexes it replaced.
 */
export function recordUniqueIndexesAsConstraints(snapshot: SqliteSnapshot, schema: SqliteSnapshot): number {
  const constraints = new Map<string, SqliteDdlEntity>()
  const schemaIndexes = new Set<string>()
  for (const entity of schema.ddl) {
    const columns = columnNames(entity)
    if (entity.entityType === "uniques" && columns) constraints.set(key(entity.table, columns), entity)
    if (entity.entityType === "indexes") schemaIndexes.add(JSON.stringify([entity.table, entity.name]))
  }
  const existing = new Set(snapshot.ddl.filter(entity => entity.entityType === "uniques").map(entity => JSON.stringify([entity.table, entity.name])))
  let replaced = 0
  snapshot.ddl = snapshot.ddl.map((entity) => {
    if (entity.entityType !== "indexes" || entity.isUnique !== true || entity.where != null) return entity
    if (schemaIndexes.has(JSON.stringify([entity.table, entity.name]))) return entity
    const columns = columnNames(entity)
    const constraint = columns && constraints.get(key(entity.table, columns))
    if (!constraint || existing.has(JSON.stringify([constraint.table, constraint.name]))) return entity
    existing.add(JSON.stringify([constraint.table, constraint.name]))
    replaced++
    return { ...constraint }
  })
  return replaced
}

function clipIdentifier(name: string, bytes: number): string {
  if (Buffer.byteLength(name) <= bytes) return name
  let clipped = ""
  for (const char of name) {
    bytes -= Buffer.byteLength(char)
    if (bytes < 0) break
    clipped += char
  }
  return clipped
}

function postgresObjectName(table: string, columns: string | undefined, suffix: string): string {
  let tableBytes = Buffer.byteLength(table)
  let columnBytes = columns === undefined ? 0 : Buffer.byteLength(columns)
  const available = 63 - suffix.length - (columns === undefined ? 1 : 2)
  while (tableBytes + columnBytes > available) {
    if (tableBytes > columnBytes) tableBytes--
    else columnBytes--
  }
  const head = clipIdentifier(table, tableBytes)
  return columns === undefined ? `${head}_${suffix}` : `${head}_${clipIdentifier(columns, columnBytes)}_${suffix}`
}

function generatedNames(entity: Record<string, unknown>): string[] {
  const columns = Array.isArray(entity.columns) && columnNames({ columns: entity.columns })
  const table = entity.table
  if (typeof table !== "string" || !columns) return []
  const columnPart = columns.join("_")
  const prefix = `${table}_${columnPart}`
  const native = (suffix: string) => postgresObjectName(table, columnPart, suffix)
  switch (entity.entityType) {
    case "pks": return [postgresObjectName(table, undefined, "pkey"), `${prefix}_pk`]
    case "uniques": return [native("key"), `${prefix}_unique`]
    case "indexes": return [native("idx"), `${prefix}_index`]
    case "fks": {
      const to = `${prefix}_${entity.tableTo}_${Array.isArray(entity.columnsTo) ? entity.columnsTo.join("_") : ""}`
      return [native("fkey"), `${to}_fk`, `${to}_fkey`]
    }
    default: return []
  }
}

/**
 * `drizzle-kit pull` marks every constraint and index name as explicit. This marks the names that Postgres, Drizzle Kit
 * 0.x, or Drizzle Kit 1.0 generate as not explicit, as `drizzle-kit up` does for a Drizzle Kit 0.x snapshot. `generate` then keeps these
 * names when the Definitions do not name the constraint, instead of renaming it. Postgres cuts names to 63 bytes.
 */
export function markGeneratedPostgresNames(snapshot: unknown): void {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.ddl)) throw new TypeError("Expected a Drizzle Kit snapshot with a DDL array.")
  for (const entity of snapshot.ddl) {
    if (!isPlainObject(entity)) throw new TypeError("Expected a Drizzle Kit snapshot DDL entity.")
    if (entity.nameExplicit !== true || typeof entity.name !== "string") continue
    if (generatedNames(entity).some(name => clipIdentifier(name, 63) === entity.name)) entity.nameExplicit = false
  }
}
