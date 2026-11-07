export { defineDatabase } from "./definition.ts"
export { chunkParameters } from "./runtime/chunk-parameters.ts"
// A package import, not a relative one, so Nuxt and hosted builds can alias the registry to their generated runtime.
export { db, schema, useDatabase } from "@vite-hub/database/runtime/registry"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export type { DatabaseRegistry, RuntimeDatabaseEntry } from "@vite-hub/database/runtime/registry"
export type {
  CloudflareD1BindingConfig,
  CloudflareD1HttpConfig,
  CloudflareHyperdriveConfig,
  DatabaseConfigValue,
  DatabaseConnectionConfig,
  Database,
  DatabaseDefinition,
  DatabaseDefinitionOptions,
  DatabaseDialect,
  DatabaseDrizzleOptions,
  DatabaseIntegrationOptions,
  DatabaseLocalRuntimeOptions,
  DatabaseNuxtIntegrationOptions,
  DatabaseRuntimeD1Options,
  DatabaseSchemaSource,
  DBModulePublicOptions,
  DiscoveredDatabaseDefinition,
  DrizzleCasing,
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
} from "./types.ts"
