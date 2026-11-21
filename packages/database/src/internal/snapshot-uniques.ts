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
function columnNames(entity: SqliteDdlEntity): string[] | undefined {
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
