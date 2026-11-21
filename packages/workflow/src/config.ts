import { defu } from "defu"

import { getHostingProvider, normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { OpenWorkflowPostgresOptions, OpenWorkflowSqliteOptions, OpenWorkflowWorkerOptions, ResolvedWorkflowOptions, WorkflowOptions, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowSharedOptions } from "./types.ts"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

interface WorkflowResolutionInput {
  hosting?: string
  inline?: boolean
}

const knownDrivers = new Set(["cloudflare", "openworkflow", "vercel"])

function readString(value: unknown, label: string): string | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value !== "string" || !value.trim()) {
    throw workflowErrorDiagnostics.WORKFLOW_C0001({ message: `\`${label}\` must be a non-empty string when provided.` })
  }
  return value.trim()
}

function readRuntimeConfigValue(value: unknown, label: string, preserveWhitespace = false): WorkflowRuntimeConfigValue | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value === "string") {
    const normalized = readString(value, label)
    return preserveWhitespace ? value : normalized
  }
  if (!isRuntimeEnvDeclaration(value)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0002({ message: `\`${label}\` must be a string or runtime env declaration.` })
  }
  return value
}

function readBoolean(value: unknown, label: string): boolean | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw workflowErrorDiagnostics.WORKFLOW_C0003({ message: `\`${label}\` must be a boolean when provided.` })
  }
  return value
}

function isRuntimeEnvDeclaration(value: unknown): value is WorkflowRuntimeEnvDeclarationLike {
  return isPlainObject(value)
    && value.kind === "env-variable"
    && (!("source" in value) || isRuntimeEnvSource(value.source))
}

function isRuntimeEnvSource(value: unknown): value is WorkflowRuntimeEnvDeclarationLike["source"] {
  return isPlainObject(value)
    && value.kind === "env"
    && typeof value.name === "string"
    && (!("names" in value) || Array.isArray(value.names) && value.names.every(name => typeof name === "string"))
}

function readPositiveInteger(value: unknown, label: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw workflowErrorDiagnostics.WORKFLOW_C0004({ message: `\`${label}\` must be a positive integer when provided.` })
  }
  return value as number
}

function normalizeOpenWorkflowPostgresOptions(value: unknown): OpenWorkflowPostgresOptions | undefined {
  if (typeof value === "undefined") {
    return undefined
  }
  if (!isPlainObject(value)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0005({ message: "`workflow.postgres` must be a plain object." })
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
    throw workflowErrorDiagnostics.WORKFLOW_C0006({ message: "`workflow.sqlite` must be a plain object." })
  }

  const namespaceId = readString(value.namespaceId, "workflow.sqlite.namespaceId")
  const path = readRuntimeConfigValue(value.path, "workflow.sqlite.path", true)
  const runMigrations = readBoolean(value.runMigrations, "workflow.sqlite.runMigrations")

  return {
    ...(namespaceId ? { namespaceId } : {}),
    ...(path ? { path } : {}),
    ...(typeof runMigrations === "boolean" ? { runMigrations } : {}),
  }
}

function normalizeOpenWorkflowWorkerOptions(value: unknown): false | OpenWorkflowWorkerOptions | undefined {
  if (typeof value === "undefined" || value === false) {
    return value
  }
  if (!isPlainObject(value)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0007({ message: "`workflow.worker` must be `false` or a plain object." })
  }

  const concurrency = readPositiveInteger(value.concurrency, "workflow.worker.concurrency")
  return typeof concurrency === "number" ? { concurrency } : {}
}

function hasOpenWorkflowStorageConfig(options: Record<string, unknown>): boolean {
  return isPlainObject(options.postgres) && isDefinedRuntimeConfigValue(options.postgres.url)
    || isPlainObject(options.sqlite) && isDefinedRuntimeConfigValue(options.sqlite.path)
}

function isDefinedRuntimeConfigValue(value: unknown): boolean {
  return typeof value === "string" && !!value.trim() || isRuntimeEnvDeclaration(value)
}

function inferDriver(options: Record<string, unknown>, hosting: string, inline: boolean): "cloudflare" | "openworkflow" | "vercel" {
  const driver = options.driver
  if (driver === "cloudflare" || driver === "openworkflow" || driver === "vercel") {
    return driver
  }
  const host = getHostingProvider(hosting)
  if (host === "netlify") {
    throw workflowErrorDiagnostics.WORKFLOW_C0008({ message: "`workflow.driver` cannot be inferred for Netlify hosting. Set `workflow.driver` explicitly or disable `workflow`." })
  }
  if (host === "cloudflare") return "cloudflare"
  if (host === "vercel") return "vercel"
  if (hosting.includes("node") || hosting.includes("docker")) return "openworkflow"
  if (hasOpenWorkflowStorageConfig(options)) return "openworkflow"
  // Without a host target, or when inline runs are allowed, the Vercel adapter runs each Workflow inline.
  if (!hosting || inline) return "vercel"
  throw workflowErrorDiagnostics.WORKFLOW_C0020({
    message: `\`workflow.driver\` cannot be inferred for ${JSON.stringify(hosting)} hosting. ViteHub infers Vercel Workflow only on Vercel. For durable runs, set \`workflow: { driver: "openworkflow", sqlite: { path: ".vitehub/data/workflow.sqlite" } }\`, or \`postgres: { url }\` instead of \`sqlite\`, and call \`startOpenWorkflowWorker()\` from \`@vite-hub/workflow/openworkflow\` in a long-lived process.`,
  })
}

function resolveDriver(options: Record<string, unknown>, hosting: string, inline: boolean): ResolvedWorkflowOptions {
  const shared: WorkflowSharedOptions = {
    ...(typeof options.binding === "string" ? { binding: options.binding } : {}),
    ...(typeof options.name === "string" ? { name: options.name } : {}),
  }
  const driver = options.driver

  // Without `driver`, Workflow picks the host's driver, so the former `provider` key would be ignored silently.
  if (driver === undefined && Object.hasOwn(options, "provider")) {
    throw workflowErrorDiagnostics.WORKFLOW_RENAMED_PROVIDER_KEY({ value: JSON.stringify(options.provider) ?? String(options.provider) })
  }
  if (typeof driver === "string" && !knownDrivers.has(driver)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0009({ message: `Unknown \`workflow.driver\`: ${JSON.stringify(driver)}. Expected "cloudflare", "openworkflow", or "vercel".` })
  }

  const resolved = inferDriver(options, hosting, inline)

  if (resolved === "cloudflare") {
    return defu(shared, { driver: "cloudflare" as const })
  }

  if (resolved === "openworkflow") {
    const postgres = normalizeOpenWorkflowPostgresOptions(options.postgres)
    const sqlite = normalizeOpenWorkflowSqliteOptions(options.sqlite)
    const worker = normalizeOpenWorkflowWorkerOptions(options.worker)
    const remote = readBoolean(options.remote, "workflow.remote")

    if (postgres?.url && sqlite?.path) {
      throw workflowErrorDiagnostics.WORKFLOW_C0012({ message: "`workflow.postgres.url` and `workflow.sqlite.path` cannot both configure OpenWorkflow storage." })
    }

    return defu(
      {
        ...(postgres ? { postgres } : {}),
        ...(sqlite ? { sqlite } : {}),
        ...(worker !== undefined ? { worker } : {}),
        ...(remote === true ? { remote } : {}),
      },
      shared,
      { driver: "openworkflow" as const },
    )
  }

  return defu(shared, { driver: "vercel" as const })
}

export function normalizeWorkflowOptions(options: WorkflowOptions | undefined, input: WorkflowResolutionInput = {}): ResolvedWorkflowOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0013({ message: "`workflow` must be a plain object." })
  }
  if (options && Object.hasOwn(options, "database") && options.database !== undefined) {
    throw workflowErrorDiagnostics.WORKFLOW_C0017({ message: "`workflow.database` is not supported. Set `workflow.sqlite.path` or `workflow.postgres.url` explicitly." })
  }
  return resolveDriver(options || {}, normalizeHosting(input.hosting), input.inline === true)
}
