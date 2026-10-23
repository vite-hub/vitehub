import type { AccessAuthorizationContext, AccessAuthorize, AccessAuthorizeResult } from "@vite-hub/runtime"
import type { Auth, BetterAuthOptions, Session, User } from "better-auth"

declare global {
  namespace ViteHub {
    interface AuthRuntimeEnv extends Record<string, unknown> {}
    /** Generated declarations set `definition` to the type of the app's Auth Definition. */
    interface AuthRegistry {}
  }
}

export type AuthRuntimeOption = "baseURL" | "secret" | "secrets"
export type AuthReservedOption = AuthRuntimeOption | "access" | "basePath" | "database" | "route" | "runtime" | "secondaryStorage"
export type AuthBetterAuthOptions = Omit<BetterAuthOptions, AuthReservedOption | "session"> & {
  session?: AuthSessionOptions
}

/** Session fields to write when a refresh extends the session. */
export type AuthSessionRefreshFields = Partial<Session> & Record<string, unknown>

export interface AuthSessionRefreshContext {
  /** The stored session before the refresh. */
  session: Session & Record<string, unknown>
  /** The user of the session, as stored before the refresh. */
  user: User & Record<string, unknown>
  /** Extend the session. Pass fields to also write them to the session. */
  refresh: (fields?: AuthSessionRefreshFields) => void
  /** End the session. It wins over `refresh()`. */
  clear: () => void
}

/** Runs when Better Auth refreshes a stored session. Call neither `refresh()` nor `clear()` to keep the current expiry. */
export type AuthSessionRefresh = (context: AuthSessionRefreshContext) => void | Promise<void>

export type AuthSessionOptions = NonNullable<BetterAuthOptions["session"]> & {
  /** Runs when a stored session passes `updateAge`. Needs a Better Auth `database` or `secondaryStorage` adapter. */
  onRefresh?: AuthSessionRefresh
}

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

export type AuthAccessAuthorizationContext = AccessAuthorizationContext
export type AuthAccessAuthorizeResult = AccessAuthorizeResult
export type AuthAccessAuthorize = AccessAuthorize

/** The checked request, Session, and user that a guarded handler receives. Only Auth guards create it. */
export type AuthAuthorization = Readonly<AuthAccessAuthorizationContext>

/** A server handler that runs only after an Auth guard accepts the request. */
export type AuthGuardedHandler<TInput, TResult> = (input: TInput, authorization: AuthAuthorization) => TResult | Promise<TResult>

/**
 * Route middleware with the `(event, next)` contract of H3 2.
 * It returns the rejection `Response`, or the result of `next()` after the check passes.
 */
export type AuthMiddleware = (event: AuthRequestInput, next: () => unknown) => Promise<unknown>

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
/** The Node request fields that ViteHub Auth reads from an H3 1 event, such as a Nuxt 4 server event. */
export interface AuthNodeRequest extends AsyncIterable<unknown> {
  body?: unknown
  connection?: { encrypted?: boolean }
  headers: Record<string, string | string[] | undefined>
  method?: string
  originalUrl?: string
  rawBody?: unknown
  socket?: { encrypted?: boolean }
  url?: string
  [key: symbol]: unknown
}
/** An H3 1 event. ViteHub Auth builds a Web Request from `node.req`. */
export interface AuthNodeRequestEvent {
  _requestBody?: unknown
  node: { req: AuthNodeRequest }
  web?: { request?: Request }
}
export type AuthRequestInput = AuthRequest | { req: AuthRequest } | AuthNodeRequestEvent
export type ViteHubAuth<Options extends BetterAuthOptions = BetterAuthOptions> = Auth<Options>
/** The Better Auth instance of an Auth Definition, with the endpoints and fields of its plugins. */
export type AuthFor<TDefinition extends AuthDefinition> = ViteHubAuth<Extract<Omit<
  TDefinition["options"] extends AuthDefinitionResolver<infer TResolved> ? TResolved : TDefinition["options"],
  AuthReservedOption
>, BetterAuthOptions>>
/** The Better Auth instance of the app's discovered Auth Definition. Without generated types, the plain instance. */
export type RegisteredAuth<TRegistry = ViteHub.AuthRegistry> = TRegistry extends { definition: infer TDefinition extends AuthDefinition }
  ? AuthFor<TDefinition>
  : ViteHubAuth
export type AuthModuleOptions = false | Record<string, never>
