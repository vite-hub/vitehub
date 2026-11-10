/** Select storage once for both the OpenWorkflow runtime and its durability report. Values are already resolved. */
export function resolveOpenWorkflowStorage(
  input: { postgresUrl?: string, sqlitePath?: string },
  readEnv: (name: string) => string | undefined,
) {
  const sqlitePath = input.sqlitePath || (!input.postgresUrl ? readEnv("OPENWORKFLOW_SQLITE_PATH") : undefined)
  if (sqlitePath) return { backend: "sqlite" as const, path: sqlitePath, source: "configured" }
  if (input.postgresUrl) return { backend: "postgres" as const, url: input.postgresUrl, source: "`workflow.postgres.url`" }
  for (const name of ["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"]) {
    const url = readEnv(name)
    if (url) return { backend: "postgres" as const, url, source: name }
  }
  return { backend: "sqlite" as const, path: ".vitehub/data/openworkflow.sqlite.db", source: "default" }
}
