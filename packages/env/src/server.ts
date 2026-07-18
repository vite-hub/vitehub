import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { invalidRuntimeEnvValue, missingRequiredEnv } from "./core/errors.ts"
import { SecretEnv } from "./secret.ts"

import type { EnvRuntimeRegistry } from "./types.ts"

type RuntimeEnv = Record<string, unknown>

interface RuntimeEnvEntry {
  default?: unknown
  required: boolean
  secret: boolean
  source: {
    label: string
    name: string
    names?: string[]
  }
}

interface RuntimeLiteralEntry {
  kind: "literal"
  value: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeLiteralEntry(value: unknown): value is RuntimeLiteralEntry {
  return isRecord(value) && value.kind === "literal"
}

function isRuntimeEnvEntry(value: unknown): value is RuntimeEnvEntry {
  return isRecord(value)
    && isRecord(value.source)
    && typeof value.source.name === "string"
    && typeof value.required === "boolean"
    && typeof value.secret === "boolean"
}

function processEnv(): RuntimeEnv {
  return typeof process === "object" && process && process.env ? process.env : {}
}

function runtimeEnv(event?: unknown): RuntimeEnv {
  return {
    ...processEnv(),
    ...getCloudflareEnv(event),
  }
}

function readRuntimeSource(entry: RuntimeEnvEntry, env: RuntimeEnv): { found: boolean, value?: unknown } {
  for (const name of entry.source.names || [entry.source.name]) {
    if (name in env) return { found: true, value: env[name] }
  }
  return { found: false }
}

function resolveRegistryValue(value: unknown, env: RuntimeEnv): unknown {
  if (isRuntimeLiteralEntry(value)) {
    return value.value
  }

  if (isRuntimeEnvEntry(value)) {
    const source = readRuntimeSource(value, env)
    const resolved = source.found ? source.value : value.default
    if (typeof resolved === "undefined") {
      if (value.required) {
        throw missingRequiredEnv(value.source.label, `Missing Runtime Env from ${value.source.label}.`)
      }
      return undefined
    }
    if (typeof resolved !== "string") {
      throw invalidRuntimeEnvValue(value.source.label, `Runtime Env from ${value.source.label} must resolve to a string.`)
    }
    return value.secret ? new SecretEnv(resolved) : resolved
  }

  if (!isRecord(value)) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveRegistryValue(child, env)]),
  )
}

export function resolveServerEnv<TServerEnv extends Record<string, unknown> = Record<string, unknown>>(
  registry: EnvRuntimeRegistry,
  event?: unknown,
): TServerEnv {
  return resolveRegistryValue(registry, runtimeEnv(event)) as TServerEnv
}
