import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

export type DrizzleCasing = "snake_case" | "camelCase"
export type DatabaseDialect = "sqlite"

export interface RuntimeEnvDeclarationLike {
  default?: unknown
  kind: "env-variable"
  source?: {
    kind: string
    name?: string
    names?: string[]
  }
}

export type DatabaseConfigValue = string | RuntimeEnvDeclarationLike

export interface CloudflareD1HttpConfig {
  authToken: DatabaseConfigValue
  url: DatabaseConfigValue
}

export interface CloudflareD1BindingConfig {
  binding?: string
  databaseId?: DatabaseConfigValue
  http?: true | CloudflareD1HttpConfig
  previewDatabaseId?: DatabaseConfigValue
  databaseName?: DatabaseConfigValue
  migrationsTable?: string
}

export interface DatabaseConnectionConfig {
  authToken?: DatabaseConfigValue
  url?: DatabaseConfigValue
}

export interface DatabaseDrizzleOptions {
  casing?: DrizzleCasing
}

export interface DatabaseLocalRuntimeOptions {
  filename?: string
}

export interface DatabaseRuntimeD1Options {
  binding?: string
  databaseId?: DatabaseConfigValue
  databaseName?: DatabaseConfigValue
  driver: "d1"
  local?: DatabaseLocalRuntimeOptions
  migrationsTable?: string
  previewDatabaseId?: DatabaseConfigValue
}

export interface DatabaseIntegrationOptions {
  cli?: false | {
    generate?: false
    migrate?: false
  }
}

export type DatabaseNuxtIntegrationOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
  projectRoot?: string
}

export interface DatabaseDefinitionOptions<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  drizzle?: DatabaseDrizzleOptions
  name?: string
  schema: TSchema
}

export interface DatabaseDefinition<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  drizzle: DatabaseDrizzleOptions
  name: string
  schema: TSchema
}

export type RuntimeDrizzleDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>
export type Database<TSchema extends Record<string, unknown> = Record<string, unknown>> = DatabaseDefinition<TSchema> & RuntimeDrizzleDatabase<TSchema>

export interface DiscoveredDatabaseDefinition {
  handler: string
  mode: "default" | "named"
  name: string
  source: string
  tableNames: string[]
}

export interface ResolvedCloudflareD1BindingConfig {
  binding: string
  databaseId?: DatabaseConfigValue
  http?: true | CloudflareD1HttpConfig
  previewDatabaseId?: DatabaseConfigValue
  databaseName?: DatabaseConfigValue
  migrationsDir: string
  migrationsTable?: string
}

export interface RuntimeDrizzleDatabaseConfig {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  drizzle: DatabaseDrizzleOptions
  name: string
}

export interface ResolvedDrizzleDatabaseConfig extends RuntimeDrizzleDatabaseConfig {
  cloudflare?: ResolvedCloudflareD1BindingConfig
  dialect: DatabaseDialect
  generatedSchemaFile: string
  migrationsDir: string
  mode: "default" | "named"
  orm: "drizzle"
}

export interface ResolvedDBViteConfig {
  databaseNames: string[]
  databases: Record<string, ResolvedDrizzleDatabaseConfig>
  definitionDefaults: {
    cloudflare?: CloudflareD1BindingConfig
    connection?: DatabaseConnectionConfig
  }
  definitions: DiscoveredDatabaseDefinition[]
  generatedDrizzleConfigFile: string
  generatedDrizzleConfigFilesByDatabase: Record<string, string>
  generatedSchemaFilesByDatabase: Record<string, string>
  rootDir: string
}

export type DBModulePublicOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
}
