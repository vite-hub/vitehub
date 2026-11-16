import { resolveDurabilityValue } from "@vite-hub/runtime/durability"
import { resolveOpenWorkflowStorage } from "./internal/openworkflow-storage.ts"

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

const sqliteFix = "Set OPENWORKFLOW_POSTGRES_URL to a Postgres URL, or set `workflow.postgres.url`."

function sqlite(path: string): Durability[] {
  return [{ primitive: "workflow", store: "openworkflow-sqlite", scope: "host", reason: `Runs in the SQLite file ${path} on this host.`, fix: sqliteFix }]
}

function postgres(source: string): Durability[] {
  return [{ primitive: "workflow", store: "openworkflow-postgres", scope: "shared", reason: `Runs in Postgres, from ${source}.` }]
}

/**
 * The durability of Workflow runs. It follows the storage order of the OpenWorkflow runtime: the SQLite path, then
 * `OPENWORKFLOW_SQLITE_PATH`, then the Postgres URL, `OPENWORKFLOW_POSTGRES_URL`, and the Postgres Default Database, then the default
 * SQLite file. The runtime and reporter share this selection.
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
  const storage = resolveOpenWorkflowStorage({
    postgresUrl: resolveDurabilityValue(input.postgresUrl, env),
    sqlitePath: resolveDurabilityValue(input.sqlitePath, env),
  }, name => env[name]?.trim() || undefined)
  if (storage.backend === "postgres") return postgres(storage.source)
  if (storage.source === "default" && input.defaultDatabase && context.find("database")?.store === "postgres") return postgres("the Default Database")
  return sqlite(storage.path)
}

/**
 * A Postgres URL for the durability input, which the build writes into the server. The reporter only needs to know
 * that it is set: environment variable names stay, and a literal URL or default becomes `set`.
 */
export function workflowDurabilityUrl(value: WorkflowRuntimeConfigValue): WorkflowRuntimeConfigValue {
  if (typeof value === "string") return "set"
  return typeof value.default === "string" ? { ...value, default: "set" } : value
}
