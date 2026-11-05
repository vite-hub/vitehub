import type { AccessAuthorizationContext, AccessAuthorize, AccessAuthorizeResult, AnonymousAccessAuthorizationContext, AnonymousAccessAuthorize, ViteHubContext } from "@vite-hub/runtime"
import type { Auth, BetterAuthOptions, DBAdapter, Session, User } from "better-auth"
import type { AuthEventsConfiguration } from "./events.ts"
import type { AuthConsoleOptions } from "./console-types.ts";
import type { AuthPreset } from "./presets.ts"
declare global {
  namespace ViteHub {
    interface AuthRuntimeEnv extends Record<string, unknown> {}
    /** Generated declarations set `definition` to the type of the app's Auth Definition. */
    interface AuthRegistry {}
  }
}

export type AuthRuntimeOption = "baseURL" | "secret" | "secrets"
export type AuthReservedOption =
  | AuthRuntimeOption
  | "events"
  | "console"
  | "access"
  | "basePath"
  | "database"
  | "preset"
  | "route"
  | "runtime"
  | "secondaryStorage";
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

export type AuthRuntimeOptions = Partial<Omit<BetterAuthOptions, "basePath">> & { events?: AuthEventsConfiguration | false }
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
export type AuthAuthorization = Readonly<AuthAccessAuthorizationContext & {
  /** `impersonatedBy` is the id of the administrator who opened this session as `user`. Better Auth's admin plugin sets it. */
  session: AuthAccessAuthorizationContext["session"] & { impersonatedBy?: string | null }
}>

/** A server handler that runs only after an Auth guard accepts the request. */
export type AuthGuardedHandler<TInput, TResult> = (input: TInput, authorization: AuthAuthorization) => TResult | Promise<TResult>

/** The checked request of a signed-out caller that `withAnonymousAuthorization()` accepted. */
export type AuthAnonymousAuthorization = Readonly<AnonymousAccessAuthorizationContext>
export type AuthAnonymousAuthorize = AnonymousAccessAuthorize

/** A server handler that runs after `authorize` accepts a signed-in or signed-out caller. */
export type AuthAnonymousGuardedHandler<TInput, TResult> = (
  input: TInput,
  authorization: AuthAuthorization | AuthAnonymousAuthorization,
) => TResult | Promise<TResult>

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

/** The Better Auth adapter of `authDatabase()`. `vitehubDatabase` names the app Database that holds the Auth tables. */
export type AuthAppDatabase = ((options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>) & { readonly vitehubDatabase: string }

export interface AuthSecondaryStorageReference {
  store: string
}

export type AuthSecondaryStorageConfiguration = true | AuthSecondaryStorageReference

export interface AuthViteHubOptions {
  /** Opt in to durable auth events with an explicit store. */
  events?: AuthEventsConfiguration | false
  console?: AuthConsoleOptions;
  access?: AuthAccessConfiguration
  basePath?: string
  /** `authDatabase()` from `@vite-hub/auth/database` keeps users and sessions in the app Database. */
  database?: AuthDatabaseConfiguration | AuthAppDatabase
  /** A ViteHub Auth preset, such as `stateless()` from `@vite-hub/auth/presets`. ViteHub checks it against the other options. */
  preset?: AuthPreset
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
  /** The app Database that `authDatabase()` names, which gets the Better Auth tables. `false` without the call. */
  tables: false | { database: string }
  definition: DiscoveredAuthDefinition
  rootDir: string
  route: false | string
  secondaryStorage: false | ResolvedAuthSecondaryStorageConfiguration
}

export type AuthBetterAuthRuntimeOptions<
  TOptions extends AuthDefinitionInput = AuthDefinitionInput,
> = (TOptions extends AuthDefinitionResolver<infer TResolved>
  ? Omit<
      TResolved,
      | AuthRuntimeOption
      | "events"
      | "console"
      | "access"
      | "database"
      | "preset"
      | "route"
      | "runtime"
      | "secondaryStorage"
    >
  : Omit<
      TOptions,
      | AuthRuntimeOption
      | "events"
      | "console"
      | "access"
      | "database"
      | "preset"
      | "route"
      | "runtime"
      | "secondaryStorage"
    >) &
  AuthRuntimeOptions &
  BetterAuthOptions;
export type AuthRequest = Pick<Request, "body" | "headers" | "method" | "signal" | "url">
/**
 * A Web Request, or a request event with Standard Context properties, such as an H3 1 or H3 2 event in a ViteHub app.
 * Auth reads the request and the Cloudflare bindings of an event from `event["~standard"]`.
 */
export type AuthRequestInput = AuthRequest | ViteHubContext
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
