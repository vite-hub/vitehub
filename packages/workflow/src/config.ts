import { defu } from "defu"

import { isPlainObject } from "@vitehub/internal/object"

import type { OpenWorkflowPostgresOptions, OpenWorkflowWorkerOptions, ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowSharedOptions } from "./types.ts"

interface WorkflowResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "node", "openworkflow", "vercel"])

function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

function readString(value: unknown, label: string): string | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`\`${label}\` must be a non-empty string when provided.`)
  }
  return value.trim()
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
  const url = readString(value.url, "workflow.postgres.url")

  return {
    ...(namespaceId ? { namespaceId } : {}),
    ...(typeof runMigrations === "boolean" ? { runMigrations } : {}),
    ...(schema ? { schema } : {}),
    ...(url ? { url } : {}),
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

function inferProvider(provider: unknown, hosting: string): "cloudflare" | "openworkflow" | "vercel" {
  if (provider === "node") {
    return "openworkflow"
  }
  if (provider === "cloudflare" || provider === "openworkflow" || provider === "vercel") {
    return provider
  }
  if (hosting.includes("cloudflare")) {
    return "cloudflare"
  }
  if (hosting.includes("node") || hosting.includes("docker")) {
    return "openworkflow"
  }
  return "vercel"
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedWorkflowOptions {
  const shared: WorkflowSharedOptions = {
    ...(typeof options.binding === "string" ? { binding: options.binding } : {}),
    ...(typeof options.name === "string" ? { name: options.name } : {}),
  }
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`workflow.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare", "openworkflow", "node", or "vercel".`)
  }

  const resolved = inferProvider(provider, hosting)

  if (resolved === "cloudflare") {
    return defu(shared, { provider: "cloudflare" as const })
  }

  if (resolved === "openworkflow") {
    const postgres = normalizeOpenWorkflowPostgresOptions(options.postgres)
    const worker = normalizeOpenWorkflowWorkerOptions(options.worker)

    return defu(
      {
        ...(postgres ? { postgres } : {}),
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
