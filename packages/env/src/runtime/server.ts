import { getCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import type { EnvRegistryEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue, SafeRuntimeConfig } from "../types.ts"

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

function resolveRuntimeValues(declarations: EnvRuntimeRegistry, env: Record<string, string | undefined>, path = "env"): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(declarations)) {
    if (!isRegistryEntry(entry)) {
      values[key] = resolveRuntimeValues(entry, env, `${path}.${key}`)
      continue
    }
    const declaration = entry
    const rawValue = env[declaration.source.name] ?? declaration.default
    if (typeof rawValue === "undefined") {
      if (declaration.required) {
        throw new Error(`[vitehub] Missing runtime env value ${path}.${key} from ${declaration.source.label}.`)
      }
      values[key] = undefined
      continue
    }
    values[key] = rawValue
  }
  return values
}

function isRegistryEntry(value: EnvRuntimeRegistryValue): value is EnvRegistryEntry {
  return "source" in value
    && typeof value.source === "object"
    && value.source !== null
    && "kind" in value.source
}
