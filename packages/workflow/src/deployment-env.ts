import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import type { ResolvedWorkflowOptions, WorkflowRuntimeConfigValue } from "./types.ts"

const owners = ["workflow"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault: boolean): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/** The entry of `workflow.postgres.url` or `workflow.sqlite.path` when the config reads it from env. A literal reads none. */
function valueEntry(value: WorkflowRuntimeConfigValue | undefined, secret: boolean): DeploymentEnvEntry[] {
  if (value === undefined || typeof value === "string") return []
  const names = value.source?.names ?? (value.source?.name ? [value.source.name] : [])
  if (!names.length) return []
  const hasDefault = typeof value.default === "string" && value.default.trim() !== ""
  return [entry(names, !hasDefault, secret, hasDefault)]
}

/**
 * The variables that OpenWorkflow reads on the deployed host: the env names of `workflow.postgres.url` or
 * `workflow.sqlite.path`, else the optional `OPENWORKFLOW_SQLITE_PATH`, `OPENWORKFLOW_POSTGRES_URL` and `DATABASE_URL`,
 * which fall back to a local SQLite file. `OPENWORKFLOW_NAMESPACE_ID` and `OPENWORKFLOW_SCHEMA` are optional.
 * Cloudflare Workflows and Vercel Workflow read none.
 */
export function workflowDeploymentEnv(workflow: ResolvedWorkflowOptions | undefined): DeploymentEnvEntry[] {
  if (workflow?.driver !== "openworkflow") return []
  const { postgres, sqlite } = workflow
  // A configured `namespaceId` or `schema` wins over its variable.
  const namespace = (configured: string | undefined) => configured ? [] : [entry(["OPENWORKFLOW_NAMESPACE_ID"], false, false, true)]
  const schema = postgres?.schema ? [] : [entry(["OPENWORKFLOW_SCHEMA"], false, false, true)]
  if (postgres?.url !== undefined) return [...valueEntry(postgres.url, true), ...namespace(postgres.namespaceId), ...schema]
  if (sqlite?.path !== undefined) return [...valueEntry(sqlite.path, false), ...namespace(sqlite.namespaceId)]
  return [
    entry(["OPENWORKFLOW_SQLITE_PATH"], false, false, true),
    entry(["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"], false, true, true),
    ...namespace(postgres?.namespaceId && sqlite?.namespaceId),
    ...schema,
  ]
}
