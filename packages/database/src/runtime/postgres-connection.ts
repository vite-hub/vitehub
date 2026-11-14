/**
 * A Postgres Database answers this property with a function that returns its connection URL outside a request. See
 * `getPostgresConnectionUrl()`. It lives apart from the Postgres client, so a SQLite app does not bundle that client.
 */
export const postgresConnectionUrl: unique symbol = Symbol.for("vitehub.database.postgres.connection-url")

/**
 * The connection URL of the Postgres Database `name` in `databases`, as its client resolves it outside a request. See
 * `getPostgresConnectionUrl()` in `@vite-hub/database`, and in the runtime module that a build generates.
 */
export function readPostgresConnectionUrl(databases: Record<string, { db: object } | undefined>, name: string): string | undefined {
  const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
  const read: unknown = entry ? Reflect.get(entry.db, postgresConnectionUrl) : undefined
  return typeof read === "function" ? read() : undefined
}
