import { resolveDurabilityValue } from "@vite-hub/runtime/durability"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"
import type { WorkflowRuntimeConfigValue } from "./types.ts"

/** What the build passes to `workflowDurability()`. The storage values may name runtime environment variables. */
export interface WorkflowDurabilityInput {
  /** OpenWorkflow uses the Postgres Default Database after the explicit storage and its environment variables. */
  defaultDatabase?: boolean
  postgresUrl?: WorkflowRuntimeConfigValue
  provider: string
  sqlitePath?: WorkflowRuntimeConfigValue
}

const sqliteFix = "Set OPENWORKFLOW_POSTGRES_URL to a Postgres URL, set `workflow.postgres.url`, or use a Postgres Default Database."

function sqlite(path: string): Durability[] {
  return [{ primitive: "workflow", store: "openworkflow-sqlite", scope: "host", reason: `Runs in the SQLite file ${path} on this host.`, fix: sqliteFix }]
}

function postgres(source: string): Durability[] {
  return [{ primitive: "workflow", store: "openworkflow-postgres", scope: "shared", reason: `Runs in Postgres, from ${source}.` }]
}

/**
 * The durability of Workflow runs. It follows the storage order of the OpenWorkflow runtime: the SQLite path, then
 * `OPENWORKFLOW_SQLITE_PATH`, then the Postgres URL and `OPENWORKFLOW_POSTGRES_URL`, then the Postgres Default Database
 * (or `DATABASE_URL` without it), then the default SQLite file.
 */
export function workflowDurability(input: WorkflowDurabilityInput, context: DurabilityContext): Durability[] {
  const { env } = context
  if (input.provider === "cloudflare") {
    return [{ primitive: "workflow", store: "cloudflare", scope: "shared", reason: "Cloudflare Workflows store each run." }]
  }
  if (input.provider !== "openworkflow") {
    return [{
      primitive: "workflow",
      store: "inline",
      scope: "process",
      reason: "Runs execute in the request process. A restart loses them.",
      fix: "Set `workflow: { provider: \"openworkflow\" }` with a Postgres URL.",
    }]
  }
  const postgresUrl = resolveDurabilityValue(input.postgresUrl, env)
  const sqlitePath = resolveDurabilityValue(input.sqlitePath, env) || (!postgresUrl ? env.OPENWORKFLOW_SQLITE_PATH?.trim() : undefined)
  if (sqlitePath) return sqlite(sqlitePath)
  if (postgresUrl) return postgres("`workflow.postgres.url`")
  if (env.OPENWORKFLOW_POSTGRES_URL?.trim()) return postgres("OPENWORKFLOW_POSTGRES_URL")
  if (input.defaultDatabase) {
    const database = context.find("database")
    if (database?.store === "postgres") return postgres("the Default Database")
  }
  else if (env.DATABASE_URL?.trim()) return postgres("DATABASE_URL")
  return sqlite(".vitehub/data/openworkflow.sqlite.db")
}
