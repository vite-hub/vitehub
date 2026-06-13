import type { Auth, BetterAuthOptions } from "better-auth"

export type AuthRuntimeOption = "baseURL" | "secret" | "secrets"
export type AuthReservedOption = AuthRuntimeOption | "basePath" | "database" | "secondaryStorage"
export type AuthBetterAuthOptions = Omit<BetterAuthOptions, AuthReservedOption>

export interface AuthDatabaseReference {
  dedicated?: boolean
  name: string
}

export type AuthDatabaseConfiguration = true | AuthDatabaseReference

export interface AuthSecondaryStorageReference {
  store: string
}

export type AuthSecondaryStorageConfiguration = true | AuthSecondaryStorageReference

export interface AuthViteHubOptions {
  basePath?: string
  database?: AuthDatabaseConfiguration
  route?: false
  secondaryStorage?: AuthSecondaryStorageConfiguration
}

export type AuthRuntimeOnlyOptions = {
  [Key in AuthRuntimeOption]?: never
}

export type AuthDefinitionOptions<TOptions extends AuthBetterAuthOptions = AuthBetterAuthOptions> =
  TOptions & AuthViteHubOptions & AuthRuntimeOnlyOptions

export interface AuthDefinition<TOptions extends AuthDefinitionOptions = AuthDefinitionOptions> {
  options: TOptions
}

export interface DiscoveredAuthDefinition {
  handler: string
  name: "default"
  source: "server-auth" | "server-auth-suffix"
}

export type ResolvedAuthDatabaseConfiguration =
  | { mode: "default" }
  | { dedicated: boolean; mode: "named"; name: string }

export type ResolvedAuthSecondaryStorageConfiguration =
  | { mode: "default" }
  | { mode: "named"; store: string }

export interface ResolvedAuthViteConfig {
  basePath: string
  database: ResolvedAuthDatabaseConfiguration
  definition: DiscoveredAuthDefinition
  rootDir: string
  route: false | string
  secondaryStorage: false | ResolvedAuthSecondaryStorageConfiguration
}

export type AuthRuntimeOptions = Pick<BetterAuthOptions, AuthRuntimeOption | "database" | "secondaryStorage">
export type AuthBetterAuthRuntimeOptions<TOptions extends AuthDefinitionOptions = AuthDefinitionOptions> =
  Omit<TOptions, AuthRuntimeOption | "database" | "route" | "secondaryStorage"> & AuthRuntimeOptions & BetterAuthOptions
export type ViteHubAuth<Options extends BetterAuthOptions = BetterAuthOptions> = Auth<Options>
export type AuthModuleOptions = false | Record<string, never>
