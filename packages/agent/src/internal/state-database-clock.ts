/**
 * The current time on the database clock, in Unix milliseconds. Agent State writes and checks every
 * expiry with it, so instances with different host clocks agree when an entry expires.
 * `julianday('now')` works on SQLite, libSQL, sqld and D1.
 */
export const STATE_DATABASE_NOW = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)"

/**
 * `STATE_DATABASE_NOW` on Postgres. `clock_timestamp()` is the server time when the statement reads it, so a long
 * transaction does not use the time when it started. Leases use the same clock.
 */
export const POSTGRES_STATE_DATABASE_NOW = "CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)"
