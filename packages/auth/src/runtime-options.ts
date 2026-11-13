import { memoryAdapter } from "better-auth/adapters/memory"
import { createAuthMiddleware } from "better-auth/api"
import { getAuthTables } from "better-auth/db"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { isRecord as isPlainObject } from "@vite-hub/internal/object"
import { resolvePublicUrl } from "@vite-hub/runtime"
import { resolveAuthMountPath } from "./application-path.ts"
import { createAdminClaimPlugin, readAdminClaim } from "./admin-claim.ts"
import { createAdminsPlugin, readAdmins } from "./admins.ts"
import { assertAuthDatabaseAdditionalFields, assertAuthDatabaseIdStrategy, authDatabaseName } from "./database-options.ts"
import { assertAuthDatabaseSchema } from "./database-schema-options.ts"
import { withPasswordHasher } from "./password.ts"
import { applyAuthPreset } from "./preset-options.ts"
import { deriveAuthSecret } from "./secret.ts"
import { validateAuthEvents } from "./events-config.ts"
import { createAuthEventsPlugin } from "./event-plugin.ts"
import { createImpersonationPlugin, withImpersonationExpiry } from "./impersonation-plugin.ts"
import { authProcessMemoryDatabase, getAuthRuntimeState } from "./runtime-state.ts"
import { clientAddressHeader } from "./client-address.ts"
import { createSessionRefreshPlugin } from "./session-refresh.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { normalizeAuthBasePath } from "./shared.ts"
import { optionsKey } from "./options-key.ts"
import { authCloudflareEnv } from "./request.ts"
import { assertNoRuntimeOption } from "./definition.ts"

import type { BetterAuthOptions } from "better-auth"
import type { ViteHubContext } from "@vite-hub/runtime"
import type {
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthRuntimeContext,
  AuthRuntimeOptions,
  AuthSessionOptions,
} from "./types.ts"

/** `true` or `{ name, dedicated }`: the removed placement form, which is not a Better Auth adapter. */
function isAuthDatabasePlacement(value: unknown): boolean {
  return typeof value === "boolean"
    || (isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key === "dedicated" || key === "name"))
}

/** `true` or `{ store }`: the removed placement form, which is not a Better Auth adapter. */
function isAuthSecondaryStoragePlacement(value: unknown): boolean {
  return typeof value === "boolean" || (isPlainObject(value) && Object.hasOwn(value, "store") && Object.keys(value).every(key => key === "store"))
}

/**
 * Without a database, Better Auth keeps users and sessions in the memory of one instance. Auth creates an instance for
 * each set of resolved options, so the instances of one Auth Definition share these tables. A restart still removes them.
 */
function sharedMemoryDatabase(definition: AuthDefinition): NonNullable<BetterAuthOptions["database"]> {
  const state = getAuthRuntimeState()
  state.memoryDatabases ??= new WeakMap()
  const tables = state.memoryDatabases.get(definition) ?? {}
  state.memoryDatabases.set(definition, tables)
  const database = (options: BetterAuthOptions) => {
    for (const { modelName } of Object.values(getAuthTables(options))) tables[modelName] ??= []
    return memoryAdapter(tables)(options)
  }
  return Object.assign(database, { [authProcessMemoryDatabase]: true })
}

declare const __VITEHUB_AUTH_DEV__: boolean | undefined

/**
 * True on a development server. The Auth Vite plugin sets `__VITEHUB_AUTH_DEV__` in the server bundle: `true` for
 * `vite dev` and a Nitro dev server, `false` for a build. A Cloudflare Worker has no `NODE_ENV`, so the flag decides there.
 */
function isDevelopmentServer(): boolean {
  if (typeof __VITEHUB_AUTH_DEV__ === "boolean") return __VITEHUB_AUTH_DEV__
  // Code that a ViteHub build did not bundle, such as a test runner, has no flag.
  const mode = globalThis.process?.env?.NODE_ENV
  return mode === "development" || mode === "test"
}

/**
 * Better Auth turns its limiter on only when `NODE_ENV` is `production`, and keeps its counters in the memory of the
 * process unless a `secondaryStorage` is set. Auth turns it on outside a development server, and keeps the counters in
 * the app Database of `authDatabase()`, where every instance and every Auth built for a request sees them.
 */
function withRateLimitDefaults(
  options: Pick<BetterAuthOptions, "rateLimit" | "secondaryStorage">,
  ownsDatabase: boolean,
): NonNullable<BetterAuthOptions["rateLimit"]> {
  const rateLimit = options.rateLimit
  const database = ownsDatabase && !rateLimit?.storage && !rateLimit?.customStorage && !options.secondaryStorage
  return { ...rateLimit, enabled: rateLimit?.enabled ?? !isDevelopmentServer(), ...(database ? { storage: "database" } : {}) }
}

/**
 * Better Auth reads the client IP from `X-Forwarded-For` by default, which a client can set and Cloudflare does not
 * send. Auth gives it the address that the host reports instead. With `trustedProxyHeaders`, the proxy address is the
 * peer, so `X-Forwarded-For` comes first.
 */
function withClientAddressHeaders(advanced: BetterAuthOptions["advanced"]): NonNullable<BetterAuthOptions["advanced"]> {
  if (advanced?.ipAddress?.ipAddressHeaders) return advanced
  const ipAddressHeaders = advanced?.trustedProxyHeaders ? ["x-forwarded-for", clientAddressHeader] : [clientAddressHeader]
  return { ...advanced, ipAddress: { ...advanced?.ipAddress, ipAddressHeaders } }
}

// Better Auth reads these variables when it builds an instance, so an instance keeps the values of that time.
const betterAuthSetupVariables = ["AUTH_SECRET", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "BETTER_AUTH_TRUSTED_ORIGINS"] as const

/**
 * The environment values that an instance for these options uses. Auth reads a value only when the options use it, so
 * the instance key and the instance read the same values, and a value that the options replace cannot fail a request.
 */
function readProviderEnvironment(options: AuthRuntimeOptions & Record<string, unknown>, event?: ViteHubContext) {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...authCloudflareEnv(event) }
  return {
    admins: readAdmins(event),
    adminClaim: options.adminClaim === false ? undefined : readAdminClaim(event),
    // Presence is significant here: Better Auth must validate an explicitly empty secret
    // instead of silently replacing it with the ViteHub-derived fallback.
    secret: Object.hasOwn(options, "secret") || Object.hasOwn(options, "secrets") ? undefined : deriveAuthSecret(event),
    betterAuth: betterAuthSetupVariables.map(name => env[name] ?? null),
  }
}

type ProviderEnvironment = ReturnType<typeof readProviderEnvironment>

function stripViteHubOptions(
  definition: AuthDefinition,
  options: AuthRuntimeOptions & Record<string, unknown>,
  environment: ProviderEnvironment,
): AuthBetterAuthRuntimeOptions {
  const {
    access: _access,
    adminClaim: _adminClaim,
    console: _console,
    database,
    events,
    route: _route,
    secondaryStorage,
    ...rest
  } = applyAuthPreset(options)

  if (isAuthDatabasePlacement(database)) {
    throw authErrorDiagnostics.AUTH_C0061({ message: "Auth `database` must be a Better Auth adapter, such as `authDatabase()`. `true` and `{ name }` do not create storage, so users and sessions would stay in memory." })
  }
  if (isAuthSecondaryStoragePlacement(secondaryStorage)) {
    throw authErrorDiagnostics.AUTH_C0062({ message: "Auth `secondaryStorage` must be a Better Auth adapter. `true` and `{ store }` do not create storage." })
  }
  const storage = {
    ...(database ? { database } : {}),
    ...(secondaryStorage ? { secondaryStorage } : {}),
  }
  if (authDatabaseName(database) !== undefined) {
    assertAuthDatabaseIdStrategy(rest.advanced?.database?.generateId)
    assertAuthDatabaseAdditionalFields(rest)
    assertAuthDatabaseSchema(rest)
  }
  validateAuthEvents(events)
  const sessionRefresh = withSessionRefresh(rest, Boolean(storage.database || storage.secondaryStorage))
  // `stateless()` keeps everything in cookies and must stay without a database.
  if (!storage.database && options.preset === undefined) storage.database = sharedMemoryDatabase(definition)
  const declaredPlugins = sessionRefresh.plugins ?? rest.plugins ?? []
  // Bounds the admin plugin's impersonation sessions, which the app or the Console can start.
  const impersonation = declaredPlugins.some(plugin => plugin.id === "admin")
  const { admins, adminClaim } = environment
  const adminsPlugin = admins.length ? createAdminsPlugin(admins, declaredPlugins) : undefined
  const adminClaimPlugin = adminClaim ? createAdminClaimPlugin(adminClaim, declaredPlugins) : undefined
  const plugins = [
    ...declaredPlugins,
    ...(impersonation ? [createImpersonationPlugin()] : []),
    ...(adminsPlugin ? [adminsPlugin] : []),
    ...(adminClaimPlugin ? [adminClaimPlugin] : []),
  ]
  const databaseHooks = impersonation ? withImpersonationExpiry(rest.databaseHooks) : rest.databaseHooks
  const eventPlugin = events ? createAuthEventsPlugin(events) : undefined
  const rateLimit = withRateLimitDefaults({ rateLimit: rest.rateLimit, secondaryStorage: storage.secondaryStorage }, authDatabaseName(database) !== undefined)
  if (eventPlugin && storage.secondaryStorage && !rest.session?.storeSessionInDatabase) storage.secondaryStorage = eventPlugin.wrapStorage(storage.secondaryStorage)
  const after = rest.hooks?.after ?? createAuthMiddleware(async () => {})
  // SAFETY: `rest` and the retained storage fields are the Better Auth runtime option shape after ViteHub-only fields are removed.
  return {
    ...rest,
    ...storage,
    ...sessionRefresh,
    // Claim reservations need the database's primary key, including when sessions use secondary storage.
    ...(adminClaimPlugin ? { verification: { ...rest.verification, storeInDatabase: true } } : {}),
    ...(databaseHooks ? { databaseHooks } : {}),
    plugins: eventPlugin ? [...plugins, eventPlugin] : plugins,
    advanced: withClientAddressHeaders(rest.advanced),
    rateLimit,
    ...(eventPlugin ? {
      hooks: { ...rest.hooks, after: Object.assign(async (...args: Parameters<typeof after>) => {
        // Capture the endpoint outcome before application/plugin after-hooks replace it.
        eventPlugin.captureOutcome(args[0])
        return after(...args)
      }, after) },
    } : {}),
    // Better Auth appends this path to an origin `baseURL`, so the app base path keeps routes and callbacks below it.
    basePath: resolveAuthMountPath(normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined)),
  } as AuthBetterAuthRuntimeOptions
}

/** Moves `session.onRefresh` into a Better Auth plugin, because Better Auth does not read it. */
function withSessionRefresh(options: Pick<AuthRuntimeOptions, "plugins" | "session">, hasSessionStore: boolean) {
  const session: AuthSessionOptions | undefined = options.session
  if (!session?.onRefresh) return {}
  if (typeof session.onRefresh !== "function") {
    throw authErrorDiagnostics.AUTH_C0041({ message: "`defineAuth()` session.onRefresh must be a function." })
  }
  if (!hasSessionStore) {
    throw authErrorDiagnostics.AUTH_C0042({ message: "`defineAuth()` session.onRefresh needs a Better Auth `database` or `secondaryStorage` adapter. Better Auth refreshes a stateless cookie cache without a hook." })
  }
  const { onRefresh, ...betterAuthSession } = session
  return {
    plugins: [...options.plugins ?? [], createSessionRefreshPlugin(onRefresh)],
    session: betterAuthSession,
  }
}

/** Without a configured secret, Better Auth signs with the secret derived from `VITEHUB_SECRET`. */
function withDerivedSecret(options: AuthBetterAuthRuntimeOptions, { secret }: ProviderEnvironment): AuthBetterAuthRuntimeOptions {
  return secret ? { ...options, secret } : options
}

export function trustsProxyHeaders(options: unknown): boolean {
  return isPlainObject(options) && isPlainObject(options.advanced) && options.advanced.trustedProxyHeaders === true
}

/**
 * Resolves one coherent option snapshot before projecting it for Better Auth or host callers. The options come from one
 * place: the static Definition object, or the object that the Definition callback returns.
 */
export function resolveAuthOptions(
  definition: AuthDefinition,
  input: {
    env?: (event?: ViteHubContext) => Record<string, unknown>
    event?: ViteHubContext
    request?: Pick<Request, "headers" | "url">
  } = {},
) {
  const { request } = input
  const callback = typeof definition.options === "function"
  const usesContext = !request || callback
  const env = usesContext ? input.env?.(input.event) ?? {} : {}
  const requestUrlOrigin = request ? new URL(request.url).origin : undefined
  const proxiedOrigin = request ? forwardedRequestOrigin(request) : undefined
  const resolveAt = (origin: string | undefined) => {
    const context: AuthRuntimeContext = {
      env,
      ...(request ? { request } : {}),
      requestOrigin: usesContext && origin ? origin : "http://localhost",
    }
    // SAFETY: The callback returns AuthRuntimeOptions and the static branch is typed as AuthRuntimeOptions by AuthDefinition.
    const declared = (callback
      // SAFETY: `callback` is true only when definition.options is the AuthDefinitionResolver branch.
      ? (definition.options as AuthDefinitionResolver)(context)
      : definition.options) as AuthRuntimeOptions & Record<string, unknown>
    if (callback) assertNoRuntimeOption(declared)
    return { declared, trusted: trustsProxyHeaders(declared) }
  }
  // Determine trust without exposing forwarded headers to a callback. Only options that trust proxy headers may select
  // a forwarded origin for callbacks and links.
  let resolved = resolveAt(requestUrlOrigin)
  if (request && callback && resolved.trusted && proxiedOrigin !== requestUrlOrigin) {
    const forwarded = resolveAt(proxiedOrigin)
    // If the callback revokes trust with the forwarded context, discard that snapshot and keep URL-derived values.
    resolved = forwarded.trusted ? forwarded : {
      trusted: false,
      declared: { ...resolved.declared, advanced: { ...resolved.declared.advanced, trustedProxyHeaders: false } },
    }
  }
  const { declared, trusted } = resolved
  // A callback result is request-scoped as a whole. A static Definition adds only the request defaults below.
  let requestRuntimeOptions = (callback ? declared : {}) as AuthRuntimeOptions & Record<string, unknown>
  if (request) {
    const requestOrigin = trusted && proxiedOrigin ? proxiedOrigin : request.url
    const baseURL = requestRuntimeOptions.baseURL || resolvePublicUrl({ request: { url: requestOrigin } })
    if (!baseURL) {
      throw authErrorDiagnostics.AUTH_R0022({ message: `[vitehub] The request host ${new URL(requestOrigin).host} is not an origin of vitehub({ publicUrl }), so Auth has no base URL.` })
    }
    // SAFETY: Origin defaults preserve the runtime options shape and add only supported Better Auth fields.
    requestRuntimeOptions = {
      ...(!Object.hasOwn(declared, "trustedOrigins") ? { trustedOrigins: [baseURL] } : {}),
      ...requestRuntimeOptions,
      baseURL,
    } as AuthRuntimeOptions & Record<string, unknown>
  }
  let snapshot: AuthRuntimeOptions & Record<string, unknown> | undefined
  const resolveSnapshot = () => snapshot ??= callback ? requestRuntimeOptions : { ...declared, ...requestRuntimeOptions }
  let environment: ProviderEnvironment | undefined
  const resolveEnvironment = () => environment ??= readProviderEnvironment(resolveSnapshot(), input.event)
  return {
    get options() { return resolveSnapshot() },
    get providerOptions() {
      const options = resolveSnapshot()
      const environment = resolveEnvironment()
      return withDerivedSecret(withPasswordHasher(stripViteHubOptions(definition, options, environment)), environment)
    },
    /** Equal for two resolutions of this Definition that give Better Auth equal options, else `undefined`. */
    get providerKey() {
      const snapshot = resolveSnapshot()
      // `authDatabase(name)` returns a new adapter on each call, but each one uses the Database of the current request,
      // so adapters of one name are equal. A callback that calls it on each request can then share its instance.
      const database = authDatabaseName(snapshot.database)
      const keyed = database === undefined ? snapshot : { ...snapshot, database: undefined }
      return optionsKey([keyed, database ?? null, resolveEnvironment()])
    },
    requestRuntimeOptions,
  }
}
