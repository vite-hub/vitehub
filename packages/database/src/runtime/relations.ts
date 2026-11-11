import { extractTablesFromSchema } from "drizzle-orm"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { AnyRelations, RelationsRecord, Schema, TableRelationalConfig } from "drizzle-orm"

/**
 * Builds the relations of one Database from its merged schema and the relations of each part, lowest precedence first.
 * Every table of the schema gets an entry, so `db.query.<table>` reads it. The relation fields of a table merge across
 * parts, and a later part wins a field name, as a later Nuxt layer wins a table key.
 */
export function mergeDatabaseRelations(
  database: string,
  schema: Record<string, unknown>,
  parts: readonly (AnyRelations | undefined)[],
): AnyRelations {
  const tables: Schema = extractTablesFromSchema(schema)
  const merged: Record<string, TableRelationalConfig & { relations: RelationsRecord }> = {}
  for (const [name, table] of Object.entries(tables)) {
    merged[name] = { name, relations: {}, table }
  }
  for (const part of parts) {
    for (const [name, config] of Object.entries(part ?? {})) {
      // `defineRelations(schema)` lists each table of a layer with no fields. A later layer may replace that table.
      if (!Object.keys(config.relations).length) continue
      const entry = merged[name]
      if (!entry) throw databaseErrorDiagnostics.DATABASE_INVALID_RELATIONS({ database, reason: "missing", table: name })
      entry.relations = { ...entry.relations, ...config.relations }
    }
  }
  // Apply field precedence before checking table identity: later layers can replace every use of an old table.
  for (const [name, entry] of Object.entries(merged)) {
    for (const [field, relation] of Object.entries(entry.relations)) {
      // Drizzle builds SQL from the table objects of each relation, so they must be the tables that the database uses.
      if (relation.sourceTable !== entry.table) throw databaseErrorDiagnostics.DATABASE_INVALID_RELATIONS({ database, reason: "replaced", table: name })
      // A many-to-many relation also joins its junction table, which `.through()` names by its schema key.
      const tables: Array<[string, unknown]> = [[relation.targetTableName, relation.targetTable]]
      const throughName = relation.through?.source[0]?._.tableName
      if (throughName !== undefined) tables.push([throughName, relation.throughTable])
      for (const [table, object] of tables) {
        if (object !== merged[table]?.table) {
          throw databaseErrorDiagnostics.DATABASE_INVALID_RELATIONS({ database, field: `${name}.${field}`, reason: merged[table] ? "replaced" : "missing", table })
        }
      }
    }
  }
  return merged
}
