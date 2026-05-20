import { getCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"
import { useRuntimeConfig } from "nitro/runtime-config"

import { SecretEnv } from "../secret.ts"

import type { EnvRegistryEntry, EnvRuntimeLiteralEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue, EnvRuntimeSchema, SafeRuntimeConfig } from "../types.ts"

export { SecretEnv } from "../secret.ts"

let registry: EnvRuntimeRegistry = {}

export function setEnvRegistry(nextRegistry: EnvRuntimeRegistry): void {
  registry = nextRegistry
}

export function useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig {
  return applyEnvRegistryToRuntimeConfig(resolveNitroRuntimeConfig(event), event)
}

export function applyEnvRegistryToRuntimeConfig(runtimeConfig: Record<string, unknown>, event?: unknown): SafeRuntimeConfig {
  const values = resolveRuntimeValues(registry, resolveRuntimeEnv(event))
  assignRuntimeValues(runtimeConfig, values)
  return runtimeConfig
}

function resolveNitroRuntimeConfig(event?: unknown): Record<string, unknown> {
  try {
    return (useRuntimeConfig as unknown as (event?: unknown) => Record<string, unknown>)(event)
  }
  catch {
    return {}
  }
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
    if (isLiteralEntry(entry)) {
      values[key] = entry.value
      continue
    }
    if (!isRegistryEntry(entry)) {
      values[key] = resolveRuntimeValues(entry, env, `${path}.${key}`)
      continue
    }
    const declaration = entry
    const rawValue = resolveEnvValue(declaration.source, env) ?? declaration.default
    if (typeof rawValue === "undefined") {
      if (declaration.required) {
        throw new Error(`[vitehub] Missing runtime env value ${path}.${key} from ${declaration.source.label}.`)
      }
      values[key] = undefined
      continue
    }
    const value = parseRuntimeValue(declaration.schema, rawValue, `${path}.${key}`)
    values[key] = declaration.secret ? new SecretEnv(value) : value
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

function resolveEnvValue(source: EnvRegistryEntry["source"], env: Record<string, string | undefined>): string | undefined {
  for (const name of source.names || [source.name]) {
    const value = env[name]
    if (typeof value !== "undefined") {
      return value
    }
  }
  return undefined
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

function isLiteralEntry(value: EnvRuntimeRegistryValue): value is EnvRuntimeLiteralEntry {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "literal"
}

function isPlainRuntimeObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}
