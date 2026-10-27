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
   * Where Jev requests go. Default: `"typesafe"`.
   * - `"typesafe"` reads `TYPESAFE_API_KEY` and calls the TypeSafe API.
   * - `"vercel"` reads `AI_GATEWAY_API_KEY` and calls Vercel AI Gateway.
   * - `"cloudflare"` reads `TYPESAFE_API_KEY` and calls TypeSafe through a Cloudflare AI Gateway custom provider. It
   *   also reads `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, the optional `CLOUDFLARE_AI_GATEWAY_TOKEN` of an
   *   authenticated gateway, and `CLOUDFLARE_AI_GATEWAY_SLUG`, the custom provider slug (default `typesafe`).
   */
  provider?: "typesafe" | "vercel" | "cloudflare"
}

/**
 * Declares the TypeSafe Jev provider, API key, and model. `defineAgent({ driver: { ask } })`, `llmGate()`, `llmRoute()`,
 * and `jev()` read this group from `env.server.typesafe`.
 */
export function typesafeEnv(options: TypesafeEnvOptions = {}): EnvRuntimeConfigOptions {
  const provider = options.provider || "typesafe"
  const vercel = provider === "vercel"
  return {
    apiKey: env({
      // Jev diagnoses a missing TypeSafe key when it runs. Vercel can use VERCEL_OIDC_TOKEN without a key.
      optional: true,
      secret: true,
      source: env.source(vercel ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY"),
    }),
    ...(provider === "cloudflare"
      ? {
          // Jev diagnoses a missing account or gateway when it runs, so an application without AI still starts.
          cloudflare: {
            accountId: env({ optional: true, source: env.source("CLOUDFLARE_ACCOUNT_ID") }),
            gatewayId: env({ optional: true, source: env.source("CLOUDFLARE_AI_GATEWAY_ID") }),
            slug: env({ default: "typesafe", source: env.source("CLOUDFLARE_AI_GATEWAY_SLUG") }),
            token: env({ optional: true, secret: true, source: env.source("CLOUDFLARE_AI_GATEWAY_TOKEN") }),
          },
        }
      : {}),
    model: env({
      default: options.model || (vercel ? "typesafe-ai/jev" : "jev-latest"),
      source: env.source("TYPESAFE_DEFAULT_MODEL"),
    }),
    provider,
  }
}
