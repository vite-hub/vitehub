/** The environment variables that postgres.js reads when it gets no connection URL. */
// Keep this list in sync with postgres.js' `parseOptions`: every PG* value it
// reads must participate in the cache key so environment changes replace the
// shared client instead of reusing options from the old environment.
export const postgresEnvNames = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSERNAME",
  "PGUSER",
  "PGPASSWORD",
  "PGSSL",
  "PGSSLNEGOTIATION",
  "PGIDLE_TIMEOUT",
  "PGCONNECT_TIMEOUT",
  "PGMAX_LIFETIME",
  "PGMAX_PIPELINE",
  "PGBACKOFF",
  "PGKEEP_ALIVE",
  "PGPREPARE",
  "PGDEBUG",
  "PGFETCH_TYPES",
  "PGPUBLICATIONS",
  "PGAPPNAME",
  "PGTARGETSESSIONATTRS",
] as const

/** A cache key of the PG* variables, or `undefined` when none is set. */
export function readPostgresEnvKey(env: NodeJS.ProcessEnv | undefined = globalThis.process?.env) {
  const values = postgresEnvNames.map(name => env?.[name] ?? "")
  return values.some(value => value.trim().length > 0) ? JSON.stringify(values) : undefined
}

/**
 * Reports whether a Postgres Database runs on PGlite in development and in `vitehub database migrate`: it sets
 * `driver: "pglite"`, or it has no URL and no PG* variables.
 */
export function runsOnPglite(driver: string | undefined, url: string | undefined, env?: NodeJS.ProcessEnv) {
  return driver === "pglite" || (!url?.trim() && !readPostgresEnvKey(env))
}
