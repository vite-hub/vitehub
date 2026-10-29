import { env } from "./core/declarations.ts"

import type { EnvRuntimeConfigOptions } from "./types.ts"

export interface OpenWorkflowEnvOptions {
  namespaceId?: string
  schema?: string
  workerConcurrency?: string
}

export function openWorkflowEnv(options: OpenWorkflowEnvOptions = {}): EnvRuntimeConfigOptions {
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

export interface TypesafeEnvOptions {
  /** Default model when `TYPESAFE_DEFAULT_MODEL` is not set. Default: `jev-latest`. */
  model?: string
}

/**
 * Declares the Server Env of the `typesafe()` AI gateway from `vite-hub/gateways`: Secret `apiKey`
 * (`TYPESAFE_API_KEY`) and `model` (`TYPESAFE_DEFAULT_MODEL`). `defineAgent({ driver: { ask } })`, `llmGate()`, and
 * `llmRoute()` use `typesafe()` when they get no other gateway. The values are optional here: Jev diagnoses a
 * missing key when it runs, so an application without AI still starts.
 */
export function typesafeEnv(options: TypesafeEnvOptions = {}): EnvRuntimeConfigOptions {
  return {
    apiKey: env({
      optional: true,
      secret: true,
      source: env.source("TYPESAFE_API_KEY"),
    }),
    model: env({
      default: options.model || "jev-latest",
      source: env.source("TYPESAFE_DEFAULT_MODEL"),
    }),
  }
}
