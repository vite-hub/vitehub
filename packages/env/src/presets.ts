import { env } from "./core/declarations.ts"

import type { EnvNitroConfigOptions } from "./types.ts"

export interface OpenWorkflowEnvOptions {
  namespaceId?: string
  schema?: string
  workerConcurrency?: string
}

export function openWorkflowEnv(options: OpenWorkflowEnvOptions = {}): EnvNitroConfigOptions {
  return {
    namespaceId: env({
      default: options.namespaceId || "production",
      source: env.source("OPENWORKFLOW_NAMESPACE_ID"),
    }),
    postgresUrl: env({
      optional: true,
      secret: true,
      source: env.source(["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"]),
    }),
    schema: env({
      default: options.schema || "openworkflow",
      source: env.source("OPENWORKFLOW_SCHEMA"),
    }),
    workerConcurrency: env({
      default: options.workerConcurrency || "10",
      source: env.source("OPENWORKFLOW_WORKER_CONCURRENCY"),
    }),
  }
}
