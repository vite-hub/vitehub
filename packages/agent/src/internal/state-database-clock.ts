/**
 * The current time on the database clock, in Unix milliseconds. Agent State writes and checks every
 * expiry with it, so instances with different host clocks agree when an entry expires.
 * `julianday('now')` works on SQLite, libSQL, sqld and D1.
 */
export const STATE_DATABASE_NOW = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)"
