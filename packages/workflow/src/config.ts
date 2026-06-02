import { defu } from "defu"

import { normalizeHosting } from "@vite-hub/internal/feature-bridge/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { OpenWorkflowPostgresOptions, OpenWorkflowSqliteOptions, OpenWorkflowWorkerOptions, ResolvedWorkflowOptions, RuntimeEnvDeclarationLike, WorkflowModuleOptions, WorkflowRuntimeConfigValue, WorkflowSharedOptions } from "./types.ts"

interface WorkflowResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "openworkflow", "vercel"])

function readString(value: unknown, label: string): string | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`\`${label}\` must be a non-empty string when provided.`)
  }
  return value.trim()
}

function readRuntimeConfigValue(value: unknown, label: string): WorkflowRuntimeConfigValue | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value === "string") {
    return readString(value, label)
  }
  if (!isRuntimeEnvDeclaration(value)) {
    throw new TypeError(`\`${label}\` must be a string or runtime env declaration.`)
  }
  return value
}

function readBoolean(value: unknown, label: string): boolean | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`\`${label}\` must be a boolean when provided.`)
  }
  return value
}

function isRuntimeEnvDeclaration(value: unknown): value is RuntimeEnvDeclarationLike {
  return isPlainObject(value)
    && value.kind === "env-variable"
    && (!("source" in value) || isRuntimeEnvSource(value.source))
}

function isRuntimeEnvSource(value: unknown): value is RuntimeEnvDeclarationLike["source"] {
  return isPlainObject(value)
    && value.kind === "env"
    && typeof value.name === "string"
    && (!("names" in value) || Array.isArray(value.names) && value.names.every(name => typeof name === "string"))
}

function readDatabaseName(value: unknown): string | undefined {
  return readString(value, "workflow.database")
}

function readPositiveInteger(value: unknown, label: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`\`${label}\` must be a positive integer when provided.`)
  }
  return value as number
}

function normalizeOpenWorkflowPostgresOptions(value: unknown): OpenWorkflowPostgresOptions | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!isPlainObject(value)) {
    throw new TypeError("`workflow.postgres` must be a plain object.")
  }

  const namespaceId = readString(value.namespaceId, "workflow.postgres.namespaceId")
  const runMigrations = readBoolean(value.runMigrations, "workflow.postgres.runMigrations")
  const schema = readString(value.schema, "workflow.postgres.schema")
  const url = readRuntimeConfigValue(value.url, "workflow.postgres.url")

  return {
    ...(namespaceId ? { namespaceId } : {}),
    ...(typeof runMigrations === "boolean" ? { runMigrations } : {}),
    ...(schema ? { schema } : {}),
    ...(url ? { url } : {}),
  }
}

function normalizeOpenWorkflowSqliteOptions(value: unknown): OpenWorkflowSqliteOptions | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!isPlainObject(value)) {
    throw new TypeError("`workflow.sqlite` must be a plain object.")
  }

  const namespaceId = readString(value.namespaceId, "workflow.sqlite.namespaceId")
  const path = readRuntimeConfigValue(value.path, "workflow.sqlite.path")
  const runMigrations = readBoolean(value.runMigrations, "workflow.sqlite.runMigrations")

  return {
    ...(namespaceId ? { namespaceId } : {}),
    ...(path ? { path } : {}),
    ...(typeof runMigrations === "boolean" ? { runMigrations } : {}),
  }
}

function normalizeOpenWorkflowWorkerOptions(value: unknown): OpenWorkflowWorkerOptions | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!isPlainObject(value)) {
    throw new TypeError("`workflow.worker` must be a plain object.")
  }

  const concurrency = readPositiveInteger(value.concurrency, "workflow.worker.concurrency")
  return typeof concurrency === "number" ? { concurrency } : {}
}

function hasOpenWorkflowStorageConfig(options: Record<string, unknown>): boolean {
  return typeof options.database === "string" && !!options.database.trim()
    || isPlainObject(options.postgres) && isDefinedRuntimeConfigValue(options.postgres.url)
    || isPlainObject(options.sqlite) && isDefinedRuntimeConfigValue(options.sqlite.path)
}

function isDefinedRuntimeConfigValue(value: unknown): boolean {
  return typeof value === "string" && !!value.trim() || isRuntimeEnvDeclaration(value)
}

function inferProvider(provider: unknown, hosting: string): "cloudflare" | "openworkflow" | "vercel" {
  if (provider === "cloudflare" || provider === "openworkflow" || provider === "vercel") {
    return provider
  }
  if (hosting.includes("cloudflare")) {
    return "cloudflare"
  }
  return "vercel"
}

function inferProviderFromOptions(options: Record<string, unknown>, hosting: string): "cloudflare" | "openworkflow" | "vercel" {
  if (typeof options.provider === "undefined" && (hosting.includes("node") || hosting.includes("docker")) && hasOpenWorkflowStorageConfig(options)) {
    return "openworkflow"
  }
  return inferProvider(options.provider, hosting)
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedWorkflowOptions {
  const shared: WorkflowSharedOptions = {
    ...(typeof options.binding === "string" ? { binding: options.binding } : {}),
    ...(typeof options.name === "string" ? { name: options.name } : {}),
  }
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`workflow.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare", "openworkflow", or "vercel".`)
  }

  const resolved = inferProviderFromOptions(options, hosting)

  if (resolved === "cloudflare") {
    return defu(shared, { provider: "cloudflare" as const })
  }

  if (resolved === "openworkflow") {
    const database = readDatabaseName(options.database)
    const postgres = normalizeOpenWorkflowPostgresOptions(options.postgres)
    const sqlite = normalizeOpenWorkflowSqliteOptions(options.sqlite)
    const worker = normalizeOpenWorkflowWorkerOptions(options.worker)

    if (database && postgres?.url) {
      throw new TypeError("`workflow.database` and `workflow.postgres.url` cannot both configure OpenWorkflow storage.")
    }
    if (database && sqlite?.path) {
      throw new TypeError("`workflow.database` and `workflow.sqlite.path` cannot both configure OpenWorkflow storage.")
    }
    if (postgres?.url && sqlite?.path) {
      throw new TypeError("`workflow.postgres.url` and `workflow.sqlite.path` cannot both configure OpenWorkflow storage.")
    }

    return defu(
      {
        ...(database ? { database } : {}),
        ...(postgres ? { postgres } : {}),
        ...(sqlite ? { sqlite } : {}),
        ...(worker ? { worker } : {}),
      },
      shared,
      { provider: "openworkflow" as const },
    )
  }

  return defu(shared, { provider: "vercel" as const })
}

export function normalizeWorkflowOptions(options: WorkflowModuleOptions | undefined, input: WorkflowResolutionInput = {}): ResolvedWorkflowOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`workflow` must be a plain object.")
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
