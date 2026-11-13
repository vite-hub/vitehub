/** Select storage once for both the OpenWorkflow runtime and its durability report. Values are already resolved. */
export function resolveOpenWorkflowStorage(
  input: { postgresUrl?: string, sqlitePath?: string },
  readEnv: (name: string) => string | undefined,
) {
  const sqlitePath = input.sqlitePath || (!input.postgresUrl ? readEnv("OPENWORKFLOW_SQLITE_PATH") : undefined)
  if (sqlitePath) return { backend: "sqlite" as const, path: sqlitePath, source: "configured" }
  if (input.postgresUrl) return { backend: "postgres" as const, url: input.postgresUrl, source: "`workflow.postgres.url`" }
  const url = readEnv("OPENWORKFLOW_POSTGRES_URL")
  if (url) return { backend: "postgres" as const, url, source: "OPENWORKFLOW_POSTGRES_URL" }
  return { backend: "sqlite" as const, path: ".vitehub/data/openworkflow.sqlite.db", source: "default" }
}
