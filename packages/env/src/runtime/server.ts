import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { useRuntimeConfig } from "nitro/runtime-config"

import { SecretEnv } from "../secret.ts"

import type { EnvRegistryEntry, EnvRuntimeLiteralEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue, EnvRuntimeSchema, ServerEnv as BaseServerEnv } from "../types.ts"

export { SecretEnv } from "../secret.ts"

export interface ServerEnv extends BaseServerEnv {}

let registry: EnvRuntimeRegistry = {}

export function setEnvRegistry(nextRegistry: EnvRuntimeRegistry): void {
  registry = nextRegistry
}

export function useServerEnv(event?: unknown): ServerEnv {
  return applyRuntimeEnvToRuntimeConfig(resolveNitroRuntimeConfig(event), event)
}

export function applyRuntimeEnvToRuntimeConfig(runtimeConfig: Record<string, unknown>, event?: unknown): ServerEnv {
  assignRuntimeEntries(runtimeConfig, registry, resolveRuntimeEnv(event))
  return runtimeConfig as ServerEnv
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

function resolveRuntimeEntry(entry: EnvRegistryEntry | EnvRuntimeLiteralEntry, env: Record<string, string | undefined>, path: string): unknown {
  if (isLiteralEntry(entry)) {
    return entry.value
  }
  const rawValue = resolveEnvValue(entry.source, env) ?? entry.default
  if (typeof rawValue === "undefined") {
    if (entry.required) {
      throw new Error(`[vitehub] Missing runtime env value ${path} from ${entry.source.label}.`)
    }
    return undefined
  }
  const value = parseRuntimeValue(entry.schema, rawValue, path)
  return entry.secret ? new SecretEnv(value) : value
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

function assignRuntimeEntries(target: Record<string, unknown>, entries: EnvRuntimeRegistry, env: Record<string, string | undefined>, path = "env"): void {
  for (const [key, entry] of Object.entries(entries)) {
    const nextPath = `${path}.${key}`
    if (!isRegistryEntry(entry) && !isLiteralEntry(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      const existing = descriptor && "value" in descriptor ? descriptor.value : undefined
      const next = isPlainRuntimeObject(existing) ? existing : {}
      assignRuntimeEntries(next, entry, env, nextPath)
      target[key] = next
      continue
    }
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => resolveRuntimeEntry(entry, env, nextPath),
    })
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
