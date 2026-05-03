import { getCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import type { EnvRegistryEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue, EnvRuntimeSchema, SafeRuntimeConfig } from "../types.ts"

let registry: EnvRuntimeRegistry = {}

export function setEnvRegistry(nextRegistry: EnvRuntimeRegistry): void {
  registry = nextRegistry
}

export function useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig {
  return resolveRuntimeValues(registry, resolveRuntimeEnv(event))
}

export function applyEnvRegistryToRuntimeConfig(runtimeConfig: Record<string, unknown>, event?: unknown): SafeRuntimeConfig {
  const values = useSafeRuntimeConfig(event)
  assignRuntimeValues(runtimeConfig, values)
  return runtimeConfig
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
    values[key] = parseRuntimeValue(declaration.schema, rawValue, `${path}.${key}`)
  }
  return values
}

function parseRuntimeValue(schema: EnvRuntimeSchema | undefined, value: unknown, label: string): unknown {
  if (!schema) {
    return value
  }
  if (schema.kind === "string" && typeof value === "string") {
    return value
  }
  throw new Error(`[vitehub] Invalid ${label}: Expected string`)
}

function assignRuntimeValues(target: Record<string, unknown>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (isPlainRuntimeObject(value)) {
      const existing = target[key]
      const next = isPlainRuntimeObject(existing) ? existing : {}
      assignRuntimeValues(next, value)
      target[key] = next
      continue
    }
    target[key] = value
  }
}

function isRegistryEntry(value: EnvRuntimeRegistryValue): value is EnvRegistryEntry {
  const source = (value as { source?: unknown }).source
  return typeof source === "object"
    && source !== null
    && (source as { kind?: unknown }).kind === "env"
    && typeof (source as { name?: unknown }).name === "string"
}

function isPlainRuntimeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
