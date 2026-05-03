import { getCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import type { EnvRegistryEntry, EnvRuntimeRegistry, SafeRuntimeConfig } from "../types.ts"

let registry: EnvRuntimeRegistry = {}

export function setEnvRegistry(nextRegistry: EnvRuntimeRegistry): void {
  registry = nextRegistry
}

export function getEnvRegistry(): EnvRuntimeRegistry {
  return registry
}

export function useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig {
  return resolveRuntimeValues(registry, resolveRuntimeEnv(event))
}

function resolveRuntimeEnv(event?: unknown): Record<string, string | undefined> {
  const cloudflareEnv = event ? getCloudflareEnv(event) : undefined
  if (!cloudflareEnv) {
    return process.env
  }

  return Object.fromEntries(Object.entries(cloudflareEnv).map(([key, value]) => [
    key,
    typeof value === "string" ? value : undefined,
  ]))
}

function resolveRuntimeValues(declarations: Record<string, EnvRegistryEntry>, env: Record<string, string | undefined>): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, declaration] of Object.entries(declarations)) {
    const value = env[declaration.source.name] ?? declaration.default
    if (typeof value === "undefined") {
      if (declaration.required) {
        throw new Error(`[vitehub] Missing runtime env value ${key} from ${declaration.source.label}.`)
      }
      values[key] = undefined
      continue
    }
    values[key] = value
  }
  return values
}
