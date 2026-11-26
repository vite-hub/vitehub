export const defaultLedgerSchema = "drizzle"

export function quotePostgresName(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function postgresLedgerTable(schema = defaultLedgerSchema): string {
  return `${quotePostgresName(schema)}."__drizzle_migrations"`
}

/**
 * Drizzle's Postgres ledger, created with the statement of `migrate` in `drizzle-orm/pg-core/async/session` 1.0, so
 * `drizzle-kit migrate`, `vitehub database migrate` and a starting server agree on what is applied.
 */
export function createPostgresLedger(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())`
}

export interface PostgresLedgerEntry {
  hash: string
  name: string
  when: number
}

export function insertPostgresLedgerRow(table: string, { hash, name, when }: PostgresLedgerEntry): string {
  return `INSERT INTO ${table} ("hash", "created_at", "name") VALUES (${sqlString(hash)}, ${when}, ${sqlString(name)})`
}
