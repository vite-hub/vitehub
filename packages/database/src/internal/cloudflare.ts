import { resolveConfigValue } from "../config-value.ts"

import type { DatabaseConfigValue, ResolvedDBViteConfig } from "../types.ts"

interface CloudflareD1ProvisionState {
  cloudflare?: {
    d1?: Record<string, string>
  }
}

interface CloudflareD1WranglerBinding {
  binding: string
  database_id: string
  database_name: string
  migrations_dir?: string
  migrations_table?: string
  preview_database_id?: string
}

type CloudflareD1UnresolvedBindingReason = "missing-database-id" | "missing-database-name"

interface CloudflareD1UnresolvedBinding {
  binding: string
  database: string
  databaseName?: string
  migrationsDir?: string
  migrationsTable?: string
  previewDatabaseId?: string
  reason: CloudflareD1UnresolvedBindingReason
}

interface CloudflareD1BindingInput {
  binding?: string
  database?: string
  databaseId?: DatabaseConfigValue
  databaseName?: DatabaseConfigValue
  migrationsDir?: string
  migrationsTable?: string
  previewDatabaseId?: DatabaseConfigValue
}

interface ResolvedCloudflareD1Binding {
  bindingName: string
  d1Database?: CloudflareD1WranglerBinding
  unresolved?: CloudflareD1UnresolvedBinding
}

interface ResolvedCloudflareD1Bindings {
  d1Databases: CloudflareD1WranglerBinding[]
  unresolved: CloudflareD1UnresolvedBinding[]
}

interface ResolveCloudflareD1BindingsOptions {
  provisionState?: CloudflareD1ProvisionState
}

function resolveProvisionedD1Id(provisionState: CloudflareD1ProvisionState | undefined, name: string) {
  return provisionState?.cloudflare?.d1?.[name]
}

export function resolveCloudflareD1BindingName(database: string, binding: string | undefined) {
  const trimmed = typeof binding === "string" ? binding.trim() : ""
  if (trimmed) return trimmed
  if (database === "default") return "DB"
  const suffix = database
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function resolveDatabaseId(config: ResolvedDBViteConfig, name: string, provisionState: CloudflareD1ProvisionState | undefined): string | undefined {
  return resolveConfigValue(config.databases[name]?.cloudflare?.databaseId)
    ?? resolveProvisionedD1Id(provisionState, name)
}

function createUnresolvedBinding(
  name: string,
  binding: string,
  database: CloudflareD1BindingInput,
  reason: CloudflareD1UnresolvedBindingReason,
): CloudflareD1UnresolvedBinding {
  const databaseName = resolveConfigValue(database.databaseName)
  const previewDatabaseId = resolveConfigValue(database.previewDatabaseId)
  return {
    binding,
    database: name,
    ...(databaseName ? { databaseName } : {}),
    ...(database.migrationsDir ? { migrationsDir: database.migrationsDir } : {}),
    ...(database.migrationsTable ? { migrationsTable: database.migrationsTable } : {}),
    ...(previewDatabaseId ? { previewDatabaseId } : {}),
    reason,
  }
}

export function resolveCloudflareD1Binding(
  input: CloudflareD1BindingInput,
  options: ResolveCloudflareD1BindingsOptions = {},
): ResolvedCloudflareD1Binding {
  const database = input.database?.trim() || "default"
  const bindingName = resolveCloudflareD1BindingName(database, input.binding)
  const databaseId = resolveConfigValue(input.databaseId) ?? resolveProvisionedD1Id(options.provisionState, database)
  const databaseName = resolveConfigValue(input.databaseName)
  const previewDatabaseId = resolveConfigValue(input.previewDatabaseId)

  if (!databaseId) {
    return {
      bindingName,
      unresolved: createUnresolvedBinding(database, bindingName, input, "missing-database-id"),
    }
  }
  if (!databaseName) {
    return {
      bindingName,
      unresolved: createUnresolvedBinding(database, bindingName, input, "missing-database-name"),
    }
  }

  return {
    bindingName,
    d1Database: {
      binding: bindingName,
      database_id: databaseId,
      database_name: databaseName,
      ...(input.migrationsDir ? { migrations_dir: input.migrationsDir } : {}),
      ...(input.migrationsTable ? { migrations_table: input.migrationsTable } : {}),
      ...(previewDatabaseId ? { preview_database_id: previewDatabaseId } : {}),
    },
  }
}

export function resolveCloudflareD1Bindings(
  config: ResolvedDBViteConfig,
  options: ResolveCloudflareD1BindingsOptions = {},
): ResolvedCloudflareD1Bindings {
  const d1Databases: CloudflareD1WranglerBinding[] = []
  const unresolved: CloudflareD1UnresolvedBinding[] = []

  for (const name of config.databaseNames) {
    const database = config.databases[name]?.cloudflare
    if (!database) continue

    const projection = resolveCloudflareD1Binding({
      database: name,
      binding: database.binding,
      databaseId: resolveDatabaseId(config, name, options.provisionState),
      databaseName: database.databaseName,
      migrationsDir: database.migrationsDir,
      migrationsTable: database.migrationsTable,
      previewDatabaseId: database.previewDatabaseId,
    })
    if (projection.d1Database) d1Databases.push(projection.d1Database)
    if (projection.unresolved) unresolved.push(projection.unresolved)
  }

  return { d1Databases, unresolved }
}

export function mergeCloudflareD1Bindings(
  current: unknown,
  generated: CloudflareD1WranglerBinding[],
): CloudflareD1WranglerBinding[] {
  const bindings: CloudflareD1WranglerBinding[] = []
  const bindingNames = new Set<string>()

  if (Array.isArray(current)) {
    for (const binding of current) {
      if (isCloudflareD1WranglerBinding(binding) && !bindingNames.has(binding.binding)) {
        bindings.push({ ...binding })
        bindingNames.add(binding.binding)
      }
    }
  }

  for (const binding of generated) {
    const index = bindings.findIndex(item => item.binding === binding.binding)
    if (index === -1) {
      bindings.push(binding)
    }
    else bindings[index] = { ...binding }
  }

  return bindings
}

function isCloudflareD1WranglerBinding(value: unknown): value is CloudflareD1WranglerBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const binding = value as Partial<CloudflareD1WranglerBinding>
  return typeof binding.binding === "string"
    && typeof binding.database_id === "string"
    && typeof binding.database_name === "string"
}
