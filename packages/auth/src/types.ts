import type { Auth, BetterAuthOptions } from "better-auth"

declare global {
  namespace ViteHub {
    interface AuthRuntimeEnv extends Record<string, unknown> {}
  }
}

export type AuthRuntimeOption = "baseURL" | "secret" | "secrets"
export type AuthReservedOption = AuthRuntimeOption | "access" | "basePath" | "database" | "route" | "runtime" | "secondaryStorage"
export type AuthBetterAuthOptions = Omit<BetterAuthOptions, AuthReservedOption>

export interface AuthRuntimeEnv extends ViteHub.AuthRuntimeEnv {}

export interface AuthRuntimeContext<TEnv extends Record<string, unknown> = AuthRuntimeEnv> {
  env: TEnv
  request?: Pick<Request, "headers" | "url">
  requestOrigin: string
}

export type AuthRuntimeOptions = Partial<Omit<BetterAuthOptions, "basePath">>
export type AuthRuntimeOptionsResolver = (context: AuthRuntimeContext) => AuthRuntimeOptions
export type AuthRuntimeConfiguration = AuthRuntimeOptions | AuthRuntimeOptionsResolver

export interface AuthSignInConfiguration {
  callbackURL?: string
  errorCallbackURL?: string
  provider: string
  requestSignUp?: boolean
  scopes?: string[]
}

export interface AuthAccessRouteConfiguration {
  authorize?: AuthAccessAuthorize
  method?: string
  route: string
}

export type AuthAccessRoute = string | AuthAccessRouteConfiguration

export interface AuthAccessAuthorizationContext {
  request: AuthRequest
  session: Record<string, unknown>
  user: Record<string, unknown> & { id: string }
}

export type AuthAccessAuthorizeResult = boolean | Response
export type AuthAccessAuthorize = (
  context: AuthAccessAuthorizationContext,
) => AuthAccessAuthorizeResult | Promise<AuthAccessAuthorizeResult>

export interface AuthAccessConfiguration {
  routes?: AuthAccessRoute[]
  signIn?: AuthSignInConfiguration
}

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
  access?: AuthAccessConfiguration
  basePath?: string
  database?: AuthDatabaseConfiguration
  route?: false
  runtime?: AuthRuntimeConfiguration
  secondaryStorage?: AuthSecondaryStorageConfiguration
}

export type AuthRuntimeOnlyOptions = {
  [Key in AuthRuntimeOption]?: never
}

export type AuthDefinitionOptions<TOptions extends AuthBetterAuthOptions = AuthBetterAuthOptions> =
  TOptions & AuthViteHubOptions & AuthRuntimeOnlyOptions

export type AuthResolvedDefinitionOptions<TOptions extends AuthBetterAuthOptions = AuthBetterAuthOptions> =
  TOptions
  & Omit<AuthViteHubOptions, "database" | "runtime" | "secondaryStorage">
  & Omit<AuthRuntimeOptions, "database" | "secondaryStorage">
  & {
    database?: AuthDatabaseConfiguration | BetterAuthOptions["database"]
    secondaryStorage?: AuthSecondaryStorageConfiguration | BetterAuthOptions["secondaryStorage"]
  }

export type AuthDefinitionResolver<TOptions extends AuthResolvedDefinitionOptions = AuthResolvedDefinitionOptions> =
  (context: AuthRuntimeContext) => TOptions

export type AuthDefinitionInput = AuthDefinitionOptions | AuthDefinitionResolver

export interface AuthDefinition<TOptions extends AuthDefinitionInput = AuthDefinitionInput> {
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

export interface ResolvedAuthAccessRoute {
  authorize?: true
  method?: string
  route: string
}

export interface ResolvedAuthViteConfig {
  access: {
    routes: ResolvedAuthAccessRoute[]
  }
  basePath: string
  database: ResolvedAuthDatabaseConfiguration
  definition: DiscoveredAuthDefinition
  rootDir: string
  route: false | string
  secondaryStorage: false | ResolvedAuthSecondaryStorageConfiguration
}

export type AuthBetterAuthRuntimeOptions<TOptions extends AuthDefinitionInput = AuthDefinitionInput> =
  (TOptions extends AuthDefinitionResolver<infer TResolved>
    ? Omit<TResolved, AuthRuntimeOption | "access" | "database" | "route" | "runtime" | "secondaryStorage">
    : Omit<TOptions, AuthRuntimeOption | "access" | "database" | "route" | "runtime" | "secondaryStorage">)
  & AuthRuntimeOptions
  & BetterAuthOptions
export type AuthRequest = Pick<Request, "body" | "headers" | "method" | "signal" | "url">
export type AuthRequestInput = AuthRequest | { req: AuthRequest }
export type ViteHubAuth<Options extends BetterAuthOptions = BetterAuthOptions> = Auth<Options>
export type AuthModuleOptions = false | Record<string, never>
