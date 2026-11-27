import { resolveDurabilityValue } from "@vite-hub/runtime/durability"
import { resolveOpenWorkflowStorage } from "./internal/openworkflow-storage.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"
import type { WorkflowRuntimeConfigValue } from "./types.ts"

/** What the build passes to `workflowDurability()`. The storage values may name runtime environment variables. */
export interface WorkflowDurabilityInput {
  /** OpenWorkflow uses the Postgres Default Database after the explicit storage and its environment variables. */
  defaultDatabase?: boolean
  postgresUrl?: WorkflowRuntimeConfigValue
  driver: string
  /** The build makes a Workflow DevKit entry for each discovered Workflow file. Only a Vercel build does. */
  native?: boolean
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
  if (input.driver === "cloudflare") {
    return [{ primitive: "workflow", store: "cloudflare", scope: "shared", reason: "Cloudflare Workflows store each run." }]
  }
  if (input.driver === "vercel" && input.native) {
    return [{ primitive: "workflow", store: "vercel", scope: "shared", reason: "Vercel Workflow DevKit stores each run of a discovered Workflow file." }]
  }
  if (input.driver !== "openworkflow") {
    return [{
      primitive: "workflow",
      store: "inline",
      scope: "process",
      reason: "Runs execute in the request process. A restart loses them.",
      fix: "The Vercel driver runs Workflows durably only in a Vercel build. Deploy to Vercel, or set `workflow: { driver: \"openworkflow\" }` with a Postgres URL to run them on this server.",
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
