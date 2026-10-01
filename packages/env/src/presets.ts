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
  /** Default model when `TYPESAFE_DEFAULT_MODEL` is not set. Default: `jev-latest`, or `typesafe-ai/jev` for `"vercel"`. */
  model?: string
  /**
   * Where Jev requests go. `"typesafe"` reads `TYPESAFE_API_KEY` and calls the TypeSafe API.
   * `"vercel"` reads `AI_GATEWAY_API_KEY` and calls Vercel AI Gateway. Default: `"typesafe"`.
   */
  provider?: "typesafe" | "vercel"
}

/**
 * Declares the TypeSafe Jev provider, API key, and model. `defineAgent({ driver: { ask } })`, `llmGate()`, and
 * `llmRoute()` read this group from `env.server.typesafe`.
 */
export function typesafeEnv(options: TypesafeEnvOptions = {}): EnvRuntimeConfigOptions {
  const provider = options.provider || "typesafe"
  const vercel = provider === "vercel"
  return {
    apiKey: env({
      // The ask Driver diagnoses a missing TypeSafe key. Vercel can use VERCEL_OIDC_TOKEN without a key.
      optional: true,
      secret: true,
      source: env.source(vercel ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY"),
    }),
    model: env({
      default: options.model || (vercel ? "typesafe-ai/jev" : "jev-latest"),
      source: env.source("TYPESAFE_DEFAULT_MODEL"),
    }),
    provider,
  }
}
