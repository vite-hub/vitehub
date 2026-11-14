export { defineDatabase } from "./definition.ts"
export { chunkParameters } from "./runtime/chunk-parameters.ts"
// A package import, not a relative one, so Nuxt and hosted builds can alias the registry to their generated runtime.
export { db, ensureMigrations, schema, useDatabase, useDatabaseBinding } from "@vite-hub/database/runtime/registry"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export type { DatabaseD1Binding, DatabaseD1Result, DatabaseD1Statement } from "./runtime/agent.ts"
export type { DatabaseRegistry, DatabaseSeed, RuntimeDatabaseEntry } from "@vite-hub/database/runtime/registry"
export type {
  CloudflareD1BindingConfig,
  CloudflareD1HttpConfig,
  CloudflareHyperdriveConfig,
  DatabaseConfigValue,
  DatabaseConnectionConfig,
  DatabaseDefinition,
  DatabaseDefinitionOptions,
  DatabaseDialect,
  DatabaseIntegrationOptions,
  DatabaseLocalRuntimeOptions,
  DatabaseNuxtIntegrationOptions,
  DatabaseRuntimeD1Options,
  DatabaseSchemaSource,
  DatabaseOptions,
  DiscoveredDatabaseDefinition,
  MergeDatabaseRelations,
  MigrationBackupOptions,
  PostgresConnectionConfig,
  PostgresDatabaseDefinition,
  PostgresDatabaseDefinitionOptions,
  ResolvedCloudflareD1BindingConfig,
  ResolvedCloudflareHyperdriveConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
  RuntimeDrizzleDatabase,
  RuntimeDrizzleDatabaseConfig,
  RuntimeEnvDeclarationLike,
  RuntimePostgresDatabase,
  SchemaRelations,
} from "./types.ts"
