import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

import { trimmed } from "@vitehub/internal/env"
import { isPlainObject } from "@vitehub/internal/object"

import type {
  CloudflareD1BindingConfig,
  DBModulePublicOptions,
  DrizzleDatabaseEntryConfig,
  ResolvedCloudflareD1BindingConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
} from "./types.ts"

const schemaFilePattern = /\.[cm]?[jt]s$/i

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`\`${label}\` must be a plain object.`)
  }
}

function readStringList(value: unknown, label: string) {
  if (typeof value === "undefined") {
    return []
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`\`${label}\` must be an array of strings.`)
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function stripWrappingQuotes(value: string) {
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim()
  }

  return value
}

function getDefaultSchemaRoot(rootDir: string, name: string) {
  return name === "default"
    ? resolve(rootDir, "src/db")
    : resolve(rootDir, "src/db", name)
}

function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
}

function resolveDefaultSchemaPaths(rootDir: string, name: string) {
  const schemaRoot = getDefaultSchemaRoot(rootDir, name)
  const schemaPaths: string[] = []
  const schemaEntry = resolve(schemaRoot, "schema.ts")
  if (existsSync(schemaEntry)) {
    schemaPaths.push(schemaEntry)
  }

  const schemaDir = resolve(schemaRoot, "schema")
  for (const entry of safeReaddir(schemaDir)) {
    if (entry.isFile() && schemaFilePattern.test(entry.name)) {
      schemaPaths.push(resolve(schemaDir, entry.name))
    }
  }

  return schemaPaths
}

function resolveConfiguredSchemaPaths(rootDir: string, schemaPaths: string[], label: string) {
  return schemaPaths.map((entry) => {
    const resolved = resolve(rootDir, entry)
    if (!existsSync(resolved)) {
      throw new Error(`[vitehub] ${label} schema path not found: ${entry}`)
    }
    return resolved
  })
}

function getDefaultDatabaseUrl(name: string) {
  return name === "default"
    ? "file:.data/db/sqlite.db"
    : `file:.data/db/${name}.sqlite.db`
}

function getDefaultMigrationsDir(name: string) {
  return name === "default"
    ? "src/db/migrations"
    : `src/db/${name}/migrations`
}

function getDefaultCloudflareBindingName(name: string) {
  if (name === "default") {
    return "DB"
  }

  const suffix = name
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase()

  return `DB_${suffix || "DATABASE"}`
}

function trimOptionalString(value: unknown, label: string) {
  if (typeof value === "undefined") {
    return undefined
  }

  if (typeof value !== "string") {
    throw new TypeError(`\`${label}\` must be a non-empty string when provided.`)
  }

  const normalized = trimmed(value)
  if (!normalized) {
    throw new TypeError(`\`${label}\` must be a non-empty string when provided.`)
  }
  return stripWrappingQuotes(normalized)
}

function normalizeCloudflareConfig(
  value: CloudflareD1BindingConfig | undefined,
  label: string,
  name: string,
  defaultMigrationsDir: string,
) {
  if (typeof value === "undefined") {
    return
  }

  assertPlainObject(value, label)
  const binding = trimOptionalString(value.binding, `${label}.binding`) || getDefaultCloudflareBindingName(name)
  const databaseId = trimOptionalString(value.databaseId, `${label}.databaseId`)
  const previewDatabaseId = trimOptionalString(value.previewDatabaseId, `${label}.previewDatabaseId`)
  const databaseName = trimOptionalString(value.databaseName, `${label}.databaseName`)
  const migrationsDir = trimOptionalString(value.migrationsDir, `${label}.migrationsDir`) || defaultMigrationsDir
  const migrationsTable = trimOptionalString(value.migrationsTable, `${label}.migrationsTable`)

  return {
    binding,
    ...(databaseId ? { databaseId } : {}),
    ...(previewDatabaseId ? { previewDatabaseId } : {}),
    ...(databaseName ? { databaseName } : {}),
    ...(migrationsDir ? { migrationsDir } : {}),
    ...(migrationsTable ? { migrationsTable } : {}),
  } satisfies ResolvedCloudflareD1BindingConfig
}

function hasHostedCloudflareDatabase(config: ResolvedCloudflareD1BindingConfig | undefined) {
  return Boolean(config?.databaseId || config?.databaseName || config?.previewDatabaseId)
}

function normalizeDatabaseEntry(
  entry: DrizzleDatabaseEntryConfig,
  label: string,
  name: string,
): ResolvedDrizzleDatabaseConfig {
  if (typeof entry.connection !== "undefined") {
    assertPlainObject(entry.connection, `${label}.connection`)
  }

  if (typeof entry.cloudflare !== "undefined") {
    assertPlainObject(entry.cloudflare, `${label}.cloudflare`)
  }

  if (typeof entry.drizzle !== "undefined") {
    assertPlainObject(entry.drizzle, `${label}.drizzle`)
  }

  const url = trimOptionalString(entry.connection?.url, `${label}.connection.url`)
  const authToken = trimOptionalString(entry.connection?.authToken, `${label}.connection.authToken`)

  if (authToken && !url) {
    throw new TypeError(`\`${label}.connection.authToken\` requires \`${label}.connection.url\`.`)
  }

  const casing = entry.drizzle?.casing
  if (typeof casing !== "undefined" && casing !== "snake_case" && casing !== "camelCase") {
    throw new TypeError(`\`${label}.drizzle.casing\` must be \`snake_case\` or \`camelCase\`.`)
  }

  const migrationsDirs = readStringList(entry.drizzle?.migrationsDirs, `${label}.drizzle.migrationsDirs`)
  const defaultMigrationsDir = getDefaultMigrationsDir(name)
  const cloudflare = normalizeCloudflareConfig(entry.cloudflare, `${label}.cloudflare`, name, defaultMigrationsDir)
  const configuredSchemaPaths = readStringList(entry.drizzle?.schemaPaths, `${label}.drizzle.schemaPaths`)

  const connection = url
    ? { authToken, url }
    : hasHostedCloudflareDatabase(cloudflare)
      ? undefined
      : { authToken: undefined, url: getDefaultDatabaseUrl(name) }

  return {
    ...(cloudflare ? { cloudflare } : {}),
    ...(connection ? { connection } : {}),
    dialect: "sqlite",
    drizzle: {
      casing,
      migrationsDirs: migrationsDirs.length ? migrationsDirs : [defaultMigrationsDir],
      schemaPaths: configuredSchemaPaths,
    },
    name,
    orm: "drizzle",
  }
}

function normalizeDBModuleOptions(options?: DBModulePublicOptions) {
  if (options === false) {
    return
  }

  if (typeof options !== "undefined") {
    assertPlainObject(options, "db")
  }

  const input = options || {}
  const orm = input.orm
  if (typeof orm !== "undefined" && orm !== "drizzle") {
    throw new TypeError("`db.orm` must be `drizzle`.")
  }

  const dialect = input.dialect
  if (typeof dialect !== "undefined" && dialect !== "sqlite") {
    throw new TypeError("`db.dialect` must be `sqlite`.")
  }

  const entries = input.databases
  if (typeof entries !== "undefined") {
    assertPlainObject(entries, "db.databases")
    if ("default" in entries) {
      throw new TypeError("`db.databases.default` is reserved. Use top-level `db.connection`, `db.drizzle`, and `db.cloudflare` for the default database.")
    }
  }

  const databases: Record<string, ResolvedDrizzleDatabaseConfig> = {
    default: normalizeDatabaseEntry(input, "db", "default"),
  }

  for (const name of Object.keys(entries || {}).sort()) {
    const entry = entries?.[name]
    assertPlainObject(entry, `db.databases.${name}`)
    databases[name] = normalizeDatabaseEntry(entry, `db.databases.${name}`, name)
  }

  return {
    databaseNames: Object.keys(databases),
    databases,
  }
}

export function normalizeDBOptions(options?: DBModulePublicOptions): ResolvedDrizzleDatabaseConfig | undefined {
  return normalizeDBModuleOptions(options)?.databases.default
}

export function resolveDBViteConfig(options?: DBModulePublicOptions, rootDir = process.cwd()): ResolvedDBViteConfig | undefined {
  const normalized = normalizeDBModuleOptions(options)
  if (!normalized) {
    return
  }

  const schemaPathsByDatabase: Record<string, string[]> = {}
  for (const name of normalized.databaseNames) {
    const database = normalized.databases[name]!
    const defaultSchemaPaths = resolveDefaultSchemaPaths(rootDir, name)
    const configuredSchemaPaths = resolveConfiguredSchemaPaths(rootDir, database.drizzle.schemaPaths, `Database "${name}"`)
    schemaPathsByDatabase[name] = [...new Set([...defaultSchemaPaths, ...configuredSchemaPaths])].sort()
  }

  return {
    databaseNames: normalized.databaseNames,
    databases: normalized.databases,
    rootDir,
    schemaPathsByDatabase,
  }
}
