/**
 * A Postgres Database answers this property with a function that returns its connection URL outside a request. See
 * `getPostgresConnectionUrl()`. It lives apart from the Postgres client, so a SQLite app does not bundle that client.
 */
export const postgresConnectionUrl: unique symbol = Symbol.for("vitehub.database.postgres.connection-url")
