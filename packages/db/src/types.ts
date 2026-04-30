export type DrizzleCasing = "snake_case" | "camelCase"

export interface CloudflareD1BindingConfig {
  binding?: string
  databaseId?: string
  previewDatabaseId?: string
  databaseName?: string
  migrationsDir?: string
  migrationsTable?: string
}

export interface DrizzleDatabaseEntryConfig {
  connection?: {
    authToken?: string
    url?: string
  }
  cloudflare?: CloudflareD1BindingConfig
  drizzle?: {
    casing?: DrizzleCasing
    migrationsDirs?: string[]
    schemaPaths?: string[]
  }
}

export interface DBModuleOptions extends DrizzleDatabaseEntryConfig {
  orm?: "drizzle"
  dialect?: "sqlite"
  databases?: Record<string, DrizzleDatabaseEntryConfig>
}

export type DBModulePublicOptions = DBModuleOptions | false

export interface ResolvedCloudflareD1BindingConfig {
  binding: string
  databaseId?: string
  previewDatabaseId?: string
  databaseName?: string
  migrationsDir?: string
  migrationsTable?: string
}

export interface ResolvedDrizzleDatabaseConfig {
  dialect: "sqlite"
  drizzle: {
    casing?: DrizzleCasing
    migrationsDirs: string[]
    schemaPaths: string[]
  }
  name: string
  orm: "drizzle"
  connection?: {
    authToken?: string
    url?: string
  }
  cloudflare?: ResolvedCloudflareD1BindingConfig
}

export interface ResolvedDBViteConfig {
  databaseNames: string[]
  databases: Record<string, ResolvedDrizzleDatabaseConfig>
  rootDir: string
  schemaPathsByDatabase: Record<string, string[]>
}
