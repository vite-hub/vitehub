import { resolveConfigValue, withConfigValueFallback } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { CloudflareD1BindingConfig, CloudflareD1Projection, DatabaseConfigValue, DBModulePublicOptions, ResolvedDBViteConfig } from "../types.ts"

export function cloudflareOptions(
  options: DBModulePublicOptions | undefined,
): CloudflareD1BindingConfig | undefined {
  if (options === false || !options || options.driver !== "d1") return
  const value: CloudflareD1BindingConfig = {}
  if (options.binding !== undefined) value.binding = options.binding
  if (options.databaseId !== undefined) value.databaseId = options.databaseId
  if (options.databaseName !== undefined) value.databaseName = options.databaseName
  if (options.cloudflare?.http !== undefined) value.http = options.cloudflare.http
  if (options.migrationsTable !== undefined) value.migrationsTable = options.migrationsTable
  if (options.previewDatabaseId !== undefined) value.previewDatabaseId = options.previewDatabaseId
  return Object.keys(value).length ? value : undefined
}

export function mergeCloudflareConfig(
  defaults: CloudflareD1BindingConfig | undefined,
  definition: CloudflareD1BindingConfig | undefined,
  ownsResource = definition?.databaseId !== undefined || definition?.databaseName !== undefined,
): CloudflareD1BindingConfig | undefined {
  if (!defaults) return definition
  if (!definition && !ownsResource) return defaults
  definition ??= {}
  const value: CloudflareD1BindingConfig = { ...defaults }
  if (definition.binding !== undefined) value.binding = definition.binding
  if (ownsResource) {
    value.databaseId = definition.databaseId
    value.databaseName = definition.databaseName
  }
  const defaultHttp = defaults.http
  const definitionHttp = definition.http
  if (definitionHttp !== undefined) {
    value.http = definitionHttp !== true && defaultHttp && defaultHttp !== true
      ? {
          authToken: definitionHttp.authToken ?? defaultHttp.authToken,
          url: definitionHttp.url ?? defaultHttp.url,
        }
      : definitionHttp
  }
  if (definition.migrationsTable !== undefined) value.migrationsTable = definition.migrationsTable
  if (ownsResource || definition.previewDatabaseId !== undefined) value.previewDatabaseId = definition.previewDatabaseId
  return value
}

export function resolveRuntimeCloudflareConfig(
  defaults: CloudflareD1BindingConfig | undefined,
  definition: CloudflareD1BindingConfig | undefined,
  options: Partial<CloudflareD1Projection> & { migrationsDir?: string, name: string },
) {
  const inheritsResource = options.resource !== "configured" && definition?.databaseId === undefined && definition?.databaseName === undefined
  const value = mergeCloudflareConfig(defaults, definition, !inheritsResource)
  if (!value) return
  const inheritedBinding = options.name === "default" ? defaults?.binding : undefined
  const binding = options.resource === "opaque" && !inheritsResource
    ? undefined
    : definition?.binding?.trim() || options.binding
      || (inheritsResource || !defaults ? resolveCloudflareD1BindingName(options.name, inheritedBinding) : undefined)
  const config: CloudflareD1BindingConfig & { migrationsDir?: string } = { ...value, binding }
  if (inheritsResource || options.resource !== "opaque") config.databaseId = withConfigValueFallback(config.databaseId, options.provisionedId)
  if (options.migrationsDir) config.migrationsDir = options.migrationsDir
  return config
}

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
  const unresolved: CloudflareD1UnresolvedBinding = {
    binding,
    database: name,
    ...(database.migrationsDir ? { migrationsDir: database.migrationsDir } : {}),
    ...(database.migrationsTable ? { migrationsTable: database.migrationsTable } : {}),
    ...(previewDatabaseId ? { previewDatabaseId } : {}),
    reason,
  }
  if (databaseName?.trim()) unresolved.databaseName = databaseName
  return unresolved
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

  if (!databaseId?.trim()) {
    return {
      bindingName,
      unresolved: createUnresolvedBinding(database, bindingName, input, "missing-database-id"),
    }
  }
  if (!databaseName?.trim()) {
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
  const bindingDatabases = new Map<string, string>()

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
    if (projection.d1Database) {
      const previous = bindingDatabases.get(projection.bindingName)
      if (previous) {
        throw databaseErrorDiagnostics.DATABASE_B0006({ message: `[vitehub] Database Definitions ${JSON.stringify(previous)} and ${JSON.stringify(name)} use the same Cloudflare D1 binding ${JSON.stringify(projection.bindingName)}. Set cloudflare.binding to a distinct name for each Definition.` })
      }
      bindingDatabases.set(projection.bindingName, name)
      d1Databases.push(projection.d1Database)
    }
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
