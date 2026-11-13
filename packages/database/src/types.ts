import type { AnyRelations, EmptyRelations, ExtractTablesFromSchema, ExtractTablesWithRelations } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"
import type { ResolvedDatabaseContribution } from "./contributions.ts"

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
  /**
   * Read from D1 read replicas through the Sessions API. Each request gets one D1 session. A request with a method
   * other than GET, HEAD, or OPTIONS starts on the primary and returns a bookmark cookie, so the same client reads its
   * own writes next. Only native D1 bindings use it. D1 over HTTP and SQLite ignore it.
   */
  readReplication?: boolean
}

export interface DatabaseConnectionConfig {
  authToken?: DatabaseConfigValue
  url?: DatabaseConfigValue
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
  /** Read from D1 read replicas. See `CloudflareD1BindingConfig.readReplication`. */
  readReplication?: boolean
}

export interface DatabaseIntegrationOptions {
  cli?: false | {
    export?: false
    generate?: false
    migrate?: false
    up?: false
  }
  /**
   * Applies pending migrations when a Node server build starts, before it handles requests. It uses the ledger and
   * data loss check of `vitehub database migrate`, and a failed migration stops the server.
   *
   * Unset, Postgres databases of a Node build migrate on start and other databases do not. Postgres migrations hold an
   * advisory lock, so several instances can start together. `true` also migrates local SQLite files, one server
   * process per file. `false` turns it off.
   */
  migrateOnStart?: boolean | {
    /** Apply migrations that drop tables or columns or delete rows. */
    allowDataLoss?: boolean
  }
  /**
   * Applies the pending migrations of each Cloudflare D1 binding as part of the deploy, before the Worker deploys. The
   * generated deploy command in `nitro.json` runs `wrangler d1 migrations apply <binding> --remote` first, so
   * `nitro deploy --prebuilt`, Workers Builds and `vitehub deploy` stop when a migration fails. The build fails with
   * `DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED` for another host, or for a database without a D1 binding.
   */
  migrateOnDeploy?: boolean
  projectRoot?: string
}

export type DatabaseNuxtIntegrationOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
}

export interface DatabaseDefinitionOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  dialect?: "sqlite"
  name?: string
  /**
   * Relations between tables, from Drizzle's `defineRelations(schema, r => ({ ... }))`. They type and run
   * `db.query.<table>.findMany({ with })`. Defaults to `defineRelations(schema)`: every table, with no relations.
   */
  relations?: TRelations
  /**
   * In `vite dev`, query the real D1 database over HTTP instead of local SQLite. Writes change real data. It uses the
   * D1 HTTP path of `cloudflare.http` with the same credentials, so `true` means `cloudflare.http: true` in development.
   * Builds ignore it.
   */
  remote?: boolean
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

/**
 * `pglite` runs a Postgres Database on PGlite, a Postgres that runs in the Node process, in `vite dev`, app tests, and
 * `vitehub database migrate`. It ignores `connection.url` and the PG* variables. A production build fails with it.
 */
export type PostgresDatabaseDriver = "pglite"

export interface PostgresDatabaseDefinitionOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  cloudflare?: CloudflareHyperdriveConfig
  connection?: PostgresConnectionConfig
  dialect: "postgresql"
  /** Without it, a Database that has no URL or PG* variables still runs on PGlite in development. */
  driver?: PostgresDatabaseDriver
  name?: string
  /** Relations between tables, from Drizzle's `defineRelations()`. See `DatabaseDefinitionOptions.relations`. */
  relations?: TRelations
  /** Only D1 has a remote development mode. */
  remote?: never
  schema: TSchema
}

export interface PostgresDatabaseDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  cloudflare?: CloudflareHyperdriveConfig
  connection?: PostgresConnectionConfig
  dialect: "postgresql"
  driver?: PostgresDatabaseDriver
  name: string
  relations: TRelations
  schema: TSchema
}

/**
 * The relations that ViteHub gives Drizzle for a schema, as `defineRelations(schema)` returns them: each table of the
 * schema, with no relations between tables. `db.query.<table>` reads one table.
 */
export type SchemaRelations<TSchema extends Record<string, unknown>> = ExtractTablesWithRelations<EmptyRelations, ExtractTablesFromSchema<TSchema>>

type RelationFields<TPart, TTable> = TTable extends keyof TPart ? TPart[TTable] extends { relations: infer TFields } ? TFields : {} : {}

type MergeRelationFields<TParts extends readonly unknown[], TTable> = TParts extends readonly [...infer TRest, infer TLast]
  ? Omit<MergeRelationFields<TRest, TTable>, keyof RelationFields<TLast, TTable>> & RelationFields<TLast, TTable>
  : {}

/**
 * The relations of a Database whose schema and relations come from several parts, such as Nuxt layers and contributed
 * tables. Every table of `TSchema` gets an entry. The relation fields of a table merge across `TParts`, lowest
 * precedence first, and a later part wins a field name. The generated `DatabaseRegistry` uses it.
 */
export type MergeDatabaseRelations<TSchema extends Record<string, unknown>, TParts extends readonly unknown[]> = {
  [TTable in keyof ExtractTablesFromSchema<TSchema>]: {
    table: ExtractTablesFromSchema<TSchema>[TTable]
    name: TTable & string
    relations: { [TField in keyof MergeRelationFields<TParts, TTable>]: MergeRelationFields<TParts, TTable>[TField] }
  }
}

export type RuntimePostgresDatabase<
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> = PgAsyncDatabase<PgQueryResultHKT, TRelations>

export interface DatabaseDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  name: string
  /** The relations of this Definition. The runtime merges them with the relations of Nuxt layers and contributed tables. */
  relations: TRelations
  remote?: boolean
  schema: TSchema
}

export type RuntimeDrizzleDatabase<
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> = SQLiteAsyncDatabase<"async", unknown, TRelations> & {
  /** Execute an atomic batch on D1, D1 HTTP, or libSQL. */
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(queries: T): Promise<BatchResponse<T>>
}
export type Database<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> = DatabaseDefinition<TSchema, TRelations> & RuntimeDrizzleDatabase<TSchema, TRelations>

/** A module whose `schema` tables join a database. */
export interface DatabaseSchemaSource {
  /** Database Definition file. ViteHub reads tables from its default export's `schema`. */
  handler: string
  /** Table keys that ViteHub can read without running the module. */
  tableNames?: string[]
}

export interface DiscoveredDatabaseDefinition {
  /** Plugin that contributed this Definition, when it was not found in the app. */
  contributor?: string
  /** The Definition that supplies the database options. */
  handler: string
  /** Absolute migrations directory, when it is not `migrations/` beside the Definition. */
  migrationsDir?: string
  mode: "default" | "named"
  name: string
  /** Why the contributing plugin adds this Definition. */
  reason?: string
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
  readReplication?: boolean
}

export interface RuntimeDrizzleDatabaseConfig {
  cloudflare?: CloudflareD1BindingConfig
  connection?: DatabaseConnectionConfig
  /** Set by the dev server when the build targets Cloudflare: local SQLite then checks the D1 limits. */
  localLimits?: "d1"
  name: string
  /** Set only in `vite dev`: the database queries its real D1 database over HTTP, even when a local binding exists. */
  remote?: true
}

export interface CloudflareD1Projection {
  binding?: string
  provisionedId?: string
  /** A non-literal Definition value may enable read replication at runtime. */
  readReplication?: "opaque"
  resource: "configured" | "inherited" | "opaque"
}

export interface ResolvedCloudflareHyperdriveConfig {
  binding: string
  hyperdriveId?: DatabaseConfigValue
}

export interface ResolvedDrizzleDatabaseConfig extends RuntimeDrizzleDatabaseConfig {
  cloudflare?: ResolvedCloudflareD1BindingConfig
  dialect: DatabaseDialect
  /** Postgres Definitions only. */
  driver?: PostgresDatabaseDriver
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

export type DatabaseOptions = false | DatabaseIntegrationOptions & Partial<DatabaseRuntimeD1Options> & {
  connection?: DatabaseConnectionConfig
}

/** Options that only the Database Nuxt bridge sets on the Vite integration. */
export interface NuxtDatabaseViteOptions {
  nuxtHostResource?: true
  /** Server directories of the Nuxt application and its layers. They replace `<projectRoot>/server`. */
  nuxtServerDirs?: string[]
}
