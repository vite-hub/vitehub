import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { ResolvedDatabaseContribution } from "./contributions.ts"

export type DrizzleCasing = "snake_case" | "camelCase"
export type DatabaseDialect = "sqlite" | "postgresql"

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
  authToken?: DatabaseConfigValue
  url?: DatabaseConfigValue
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
  cloudflare?: Pick<CloudflareD1BindingConfig, "http">
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
  projectRoot?: string
}

export type DatabaseNuxtIntegrationOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
}

export interface DatabaseDefinitionOptions<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  dialect?: "sqlite"
  drizzle?: DatabaseDrizzleOptions
  name?: string
  schema: TSchema
}

export interface CloudflareHyperdriveConfig {
  /** Hyperdrive binding. Defaults to `HYPERDRIVE` for a Default Database and `HYPERDRIVE_<NAME>` for a Named Database. */
  binding?: string
  /** Hyperdrive configuration id. ViteHub adds the binding to generated Wrangler config when it is set. */
  hyperdriveId?: DatabaseConfigValue
}

export interface PostgresConnectionConfig {
  url?: DatabaseConfigValue
}

export interface PostgresDatabaseDefinitionOptions<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareHyperdriveConfig
  connection?: PostgresConnectionConfig
  dialect: "postgresql"
  drizzle?: DatabaseDrizzleOptions
  name?: string
  schema: TSchema
}

export interface PostgresDatabaseDefinition<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareHyperdriveConfig
  connection?: PostgresConnectionConfig
  dialect: "postgresql"
  drizzle: DatabaseDrizzleOptions
  name: string
  schema: TSchema
}

export type RuntimePostgresDatabase<TSchema extends Record<string, unknown>> = PgDatabase<PgQueryResultHKT, TSchema>

export interface DatabaseDefinition<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  drizzle: DatabaseDrizzleOptions
  name: string
  schema: TSchema
}

export type RuntimeDrizzleDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema> & {
  /** Execute an atomic batch on D1, D1 HTTP, or libSQL. */
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(queries: T): Promise<BatchResponse<T>>
}
export type Database<TSchema extends Record<string, unknown> = Record<string, unknown>> = DatabaseDefinition<TSchema> & RuntimeDrizzleDatabase<TSchema>

/** A module whose `schema` tables join a database. */
export interface DatabaseSchemaSource {
  /** Database Definition file. ViteHub reads tables from its default export's `schema`. */
  handler: string
  /** Table keys that ViteHub can read without running the module. */
  tableNames?: string[]
}

export interface DiscoveredDatabaseDefinition {
  /** The Definition that supplies the database options. */
  handler: string
  mode: "default" | "named"
  name: string
  /** Schema modules merged into this database, lowest precedence first. A later table key replaces an earlier one. */
  schemaSources: DatabaseSchemaSource[]
  source: string
  /** Table keys of all schema sources. */
  tableNames?: string[]
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

export interface CloudflareD1Projection {
  binding?: string
  provisionedId?: string
  resource: "configured" | "inherited" | "opaque"
}

export interface ResolvedCloudflareHyperdriveConfig {
  binding: string
  hyperdriveId?: DatabaseConfigValue
}

export interface ResolvedDrizzleDatabaseConfig extends RuntimeDrizzleDatabaseConfig {
  cloudflare?: ResolvedCloudflareD1BindingConfig
  dialect: DatabaseDialect
  generatedSchemaFile: string
  /** Postgres Definitions only. */
  hyperdrive?: ResolvedCloudflareHyperdriveConfig
  migrationsDir: string
  mode: "default" | "named"
  orm: "drizzle"
}

export interface ResolvedDBViteConfig {
  databaseNames: string[]
  databases: Record<string, ResolvedDrizzleDatabaseConfig>
  definitionDefaults: {
    cloudflare?: CloudflareD1BindingConfig
    cloudflareProjections: Record<string, CloudflareD1Projection>
    connection?: DatabaseConnectionConfig
  }
  definitions: DiscoveredDatabaseDefinition[]
  generatedDrizzleConfigFile: string
  generatedDrizzleConfigFilesByDatabase: Record<string, string>
  generatedSchemaFilesByDatabase: Record<string, string>
  rootDir: string
  /** Tables that Vite plugins contribute, by target Database name. */
  tableContributionsByDatabase: Record<string, ResolvedDatabaseContribution[]>
}

export type DBModulePublicOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
}

/** Options that only the Database Nuxt bridge sets on the Vite integration. */
export interface NuxtDatabaseViteOptions {
  nuxtHostResource?: true
  /** Server directories of the Nuxt application and its layers. They replace `<projectRoot>/server`. */
  nuxtServerDirs?: string[]
}
