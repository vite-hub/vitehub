import * as v from "valibot"

import type { EnvValueSchema } from "../types.ts"

export interface RuntimeEnvEntry {
  default?: unknown
  required: boolean
  schema?: EnvValueSchema
  secret: boolean
  source: { canonical?: string | false, kind: "env", label: string, name: string, names?: string[], skipEmpty?: boolean }
}

export interface RuntimeProviderEntry {
  default?: unknown
  required: boolean
  schema?: EnvValueSchema
  secret: boolean
  source: { key: string, kind: "provider", label: "provider", provider: string }
}

export interface RuntimeLiteralEntry {
  kind: "literal"
  value: unknown
}

const recordSchema = v.object({})
const envEntrySchema = v.object({
  required: v.boolean(),
  secret: v.boolean(),
  source: v.object({ kind: v.literal("env"), name: v.string() }),
})
const providerEntrySchema = v.object({
  required: v.boolean(),
  secret: v.boolean(),
  source: v.object({ key: v.string(), kind: v.literal("provider"), provider: v.string() }),
})

export function isRecord(value: unknown): value is Record<string, unknown> {
  return v.is(recordSchema, value) && !Array.isArray(value)
}

export function isRuntimeLiteralEntry(value: unknown): value is RuntimeLiteralEntry {
  return isRecord(value) && value.kind === "literal"
}

export function isRuntimeEnvEntry(value: unknown): value is RuntimeEnvEntry {
  return isRecord(value)
    && isRecord(value.source)
    && v.is(envEntrySchema, value)
}

export function isRuntimeProviderEntry(value: unknown): value is RuntimeProviderEntry {
  return isRecord(value)
    && isRecord(value.source)
    && v.is(providerEntrySchema, value)
}

export type RuntimeRegistryEntry = RuntimeLiteralEntry | RuntimeEnvEntry | RuntimeProviderEntry

/** Visits declarations once. Literal values and declaration metadata are opaque to traversal. */
export function* runtimeRegistryEntries(value: unknown, path = "env.server"): Generator<{ entry: RuntimeRegistryEntry, path: string }> {
  if (isRuntimeLiteralEntry(value) || isRuntimeEnvEntry(value) || isRuntimeProviderEntry(value)) {
    yield { entry: value, path }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    yield* runtimeRegistryEntries(child, `${path}.${key.includes(".") ? "!" : ""}${key}`)
  }
}
