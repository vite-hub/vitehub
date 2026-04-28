export type DrizzleCasing = "snake_case" | "camelCase"

export interface DrizzleDBConfig {
  orm?: "drizzle"
  dialect?: "sqlite"
  connection?: {
    authToken?: string
    url?: string
  }
  drizzle?: {
    casing?: DrizzleCasing
    migrationsDirs?: string[]
    schemaPaths?: string[]
  }
}

export type DBModuleOptions = DrizzleDBConfig | false

export interface ResolvedDrizzleDBConfig {
  orm: "drizzle"
  dialect: "sqlite"
  connection: {
    authToken?: string
    url: string
  }
  drizzle: {
    casing?: DrizzleCasing
    migrationsDirs: string[]
    schemaPaths: string[]
  }
}

export interface ResolvedDBViteConfig {
  db: ResolvedDrizzleDBConfig
  rootDir: string
  schemaPaths: string[]
}
