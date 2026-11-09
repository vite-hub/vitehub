import type { Durability } from "@vite-hub/runtime/durability"
import type { WorkflowRuntimeConfigValue } from "./types.ts"

/** What the build passes to `workflowDurability()`. The storage values may name runtime environment variables. */
export interface WorkflowDurabilityInput {
  postgresUrl?: WorkflowRuntimeConfigValue
  provider: string
  sqlitePath?: WorkflowRuntimeConfigValue
}

type Env = Record<string, string | undefined>

function readEnv(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined
}

function resolveValue(value: WorkflowRuntimeConfigValue | undefined, env: Env): string | undefined {
  if (typeof value !== "object") return value?.trim() || undefined
  for (const name of value.source?.names ?? (value.source?.name ? [value.source.name] : [])) {
    const resolved = readEnv(env, name)
    if (resolved) return resolved
  }
  return typeof value.default === "string" ? value.default.trim() || undefined : undefined
}

const sqliteFix = "Set OPENWORKFLOW_POSTGRES_URL or DATABASE_URL to a Postgres URL, or set `workflow.postgres.url`."

/**
 * The durability of Workflow runs. It follows the storage order of the OpenWorkflow runtime: the SQLite path, then
 * `OPENWORKFLOW_SQLITE_PATH`, then the Postgres URL, `OPENWORKFLOW_POSTGRES_URL`, and `DATABASE_URL`, then the default
 * SQLite file.
 */
export function workflowDurability(input: WorkflowDurabilityInput, env: Env): Durability[] {
  if (input.provider === "cloudflare") {
    return [{ primitive: "workflow", store: "cloudflare", scope: "shared", reason: "Cloudflare Workflows store each run." }]
  }
  if (input.provider !== "openworkflow") {
    return [{
      primitive: "workflow",
      store: "inline",
      scope: "process",
      reason: "Runs execute in the request process. A restart loses them.",
      fix: "Set `workflow: { provider: \"openworkflow\" }` and DATABASE_URL to a Postgres URL.",
    }]
  }
  const postgresUrl = resolveValue(input.postgresUrl, env)
  const sqlitePath = resolveValue(input.sqlitePath, env) || (!postgresUrl ? readEnv(env, "OPENWORKFLOW_SQLITE_PATH") : undefined)
  if (sqlitePath) {
    return [{ primitive: "workflow", store: "openworkflow-sqlite", scope: "host", reason: `Runs in the SQLite file ${sqlitePath} on this host.`, fix: sqliteFix }]
  }
  if (postgresUrl || readEnv(env, "OPENWORKFLOW_POSTGRES_URL") || readEnv(env, "DATABASE_URL")) {
    return [{ primitive: "workflow", store: "openworkflow-postgres", scope: "shared", reason: "Runs in Postgres." }]
  }
  return [{ primitive: "workflow", store: "openworkflow-sqlite", scope: "host", reason: "Runs in the SQLite file .vitehub/data/openworkflow.sqlite.db on this host.", fix: sqliteFix }]
}
