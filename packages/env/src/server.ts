import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

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

function readRuntimeSource(entry: RuntimeEnvEntry, env: RuntimeEnv): string | undefined {
  for (const name of entry.source.names || [entry.source.name]) {
    const value = env[name]
    if (typeof value === "string") return value
  }
}

function resolveRegistryValue(value: unknown, env: RuntimeEnv): unknown {
  if (isRuntimeLiteralEntry(value)) {
    return value.value
  }

  if (isRuntimeEnvEntry(value)) {
    const resolved = readRuntimeSource(value, env) ?? value.default
    if (typeof resolved === "undefined") {
      if (value.required) {
        throw new Error(`Missing Runtime Env from ${value.source.label}.`)
      }
      return undefined
    }
    if (typeof resolved !== "string") {
      throw new Error(`Runtime Env from ${value.source.label} must resolve to a string.`)
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

export function runWithServerEnv<T>(event: unknown, callback: () => T): T {
  const globals = globalThis as { __env__?: RuntimeEnv }
  const hadGlobalEnv = Object.prototype.hasOwnProperty.call(globals, "__env__")
  const previousGlobalEnv = globals.__env__
  const env = getCloudflareEnv(event)
  if (env) globals.__env__ = env

  try {
    const result = callback()
    if (isPromiseLike(result)) {
      return result.finally(() => restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)) as T
    }
    restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
    return result
  }
  catch (error) {
    restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
    throw error
  }
}

function restoreGlobalEnv(globals: { __env__?: RuntimeEnv }, hadGlobalEnv: boolean, previousGlobalEnv: RuntimeEnv | undefined): void {
  if (hadGlobalEnv) globals.__env__ = previousGlobalEnv
  else delete globals.__env__
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { finally?: unknown }).finally === "function"
}
