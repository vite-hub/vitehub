import { validateAuthEvents } from "./events-config.ts"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthAccessConfiguration,
  AuthBetterAuthOptions,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthDefinitionOptions,
  AuthResolvedDefinitionOptions,
  AuthSignInConfiguration,
  AuthViteHubOptions,
} from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { applyAuthPreset } from "./preset-options.ts"
import { authDatabaseName } from "./database-options.ts"
import { isRecord as isPlainObject } from "@vite-hub/internal/object"

const authRuntimeOptionNames = new Set(["baseURL", "secret", "secrets"])
const accessRouteKeys = new Set(["authorize", "method", "route"])

function validateAuthDatabase(value: unknown): void {
  // `authDatabase()` resolves the Database of each request, so a static Definition can hold it.
  if (typeof value === "undefined" || value === "memory" || authDatabaseName(value) !== undefined) return
  throw authErrorDiagnostics.AUTH_C0021({ message: "`defineAuth()` database must be `authDatabase()` from `@vite-hub/auth/database` or `\"memory\"`. `true` and `{ name }` do not create storage. Return another Better Auth adapter from the Definition callback." })
}

/** `runtime` was a second way to resolve options. Its shallow merge replaced whole objects such as `advanced`. */
export function assertNoRuntimeOption(options: object): void {
  if (!Object.hasOwn(options, "runtime")) return
  throw authErrorDiagnostics.AUTH_C0039({ message: "`defineAuth()` no longer takes `runtime`. Pass one callback that returns all options, so no option replaces another." })
}

function validateAuthSecondaryStorage(value: unknown): void {
  if (typeof value === "undefined") return
  throw authErrorDiagnostics.AUTH_C0024({ message: "`defineAuth()` secondaryStorage takes only a Better Auth adapter, from the Definition callback. `true` and `{ store }` do not create storage." })
}

function validateStringValue(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw authErrorDiagnostics.AUTH_C0026({ message: `\`defineAuth()\` ${label} must be a non-empty string.` })
  }
}

function validateRouteValue(value: unknown, label: string): void {
  validateStringValue(value, label)
  if (typeof value === "string" && !value.startsWith("/")) {
    throw authErrorDiagnostics.AUTH_C0027({ message: `\`defineAuth()\` ${label} must start with \`/\`.` })
  }
}

function validateAuthSignIn(value: AuthSignInConfiguration | undefined): void {
  if (typeof value === "undefined") return
  if (!isPlainObject(value)) {
    throw authErrorDiagnostics.AUTH_C0028({ message: "`defineAuth()` access.signIn must be an object." })
  }

  validateStringValue(value.provider, "access.signIn.provider")
  if (typeof value.callbackURL !== "undefined") validateStringValue(value.callbackURL, "access.signIn.callbackURL")
  if (typeof value.errorCallbackURL !== "undefined") validateStringValue(value.errorCallbackURL, "access.signIn.errorCallbackURL")
  if (typeof value.requestSignUp !== "undefined" && typeof value.requestSignUp !== "boolean") {
    throw authErrorDiagnostics.AUTH_C0029({ message: "`defineAuth()` access.signIn.requestSignUp must be a boolean." })
  }
  if (typeof value.scopes !== "undefined" && (!Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== "string"))) {
    throw authErrorDiagnostics.AUTH_C0030({ message: "`defineAuth()` access.signIn.scopes must be an array of strings." })
  }
}

function validateAuthAccessRoute(value: unknown, label: string): void {
  if (typeof value === "string") {
    validateRouteValue(value, label)
    return
  }

  if (!isPlainObject(value)) {
    throw authErrorDiagnostics.AUTH_C0031({ message: `\`defineAuth()\` ${label} must be a route string or route object.` })
  }

  const unknownKey = Object.keys(value).find(key => !accessRouteKeys.has(key))
  if (unknownKey) {
    throw authErrorDiagnostics.AUTH_C0032({ message: `\`defineAuth()\` ${label} does not support the "${unknownKey}" option.` })
  }

  validateRouteValue(value.route, `${label}.route`)
  if (typeof value.authorize !== "undefined" && typeof value.authorize !== "function") {
    throw authErrorDiagnostics.AUTH_C0033({ message: `\`defineAuth()\` ${label}.authorize must be a function.` })
  }
  if (typeof value.method !== "undefined") validateStringValue(value.method, `${label}.method`)
}

function validateAuthAccess(value: AuthAccessConfiguration | undefined): void {
  if (typeof value === "undefined") return
  if (!isPlainObject(value)) {
    throw authErrorDiagnostics.AUTH_C0034({ message: "`defineAuth()` access must be an object." })
  }

  const access = value as AuthAccessConfiguration
  if (typeof access.routes !== "undefined") {
    if (!Array.isArray(access.routes)) {
      throw authErrorDiagnostics.AUTH_C0035({ message: "`defineAuth()` access.routes must be an array." })
    }
    access.routes.forEach((route, index) => validateAuthAccessRoute(route, `access.routes[${index}]`))
  }
  validateAuthSignIn(access.signIn)
}

export function defineAuth<const TOptions extends AuthResolvedDefinitionOptions>(
  options: AuthDefinitionResolver<TOptions>,
): AuthDefinition<AuthDefinitionResolver<TOptions>>

// `runtime` in the constraint makes a Definition that still sets it report `runtime` itself. Without it, TypeScript
// reports that the object is not a resolver function.
export function defineAuth<const TOptions extends AuthBetterAuthOptions & Pick<AuthViteHubOptions, "database" | "runtime">>(
  options: AuthDefinitionOptions<TOptions>,
): AuthDefinition<AuthDefinitionOptions<TOptions>>

export function defineAuth(
  options: AuthDefinitionOptions | AuthDefinitionResolver,
): AuthDefinition {
  return defineAuthOptions(options)
}

function defineAuthOptions(
  options: AuthDefinitionOptions | AuthDefinitionResolver,
): AuthDefinition {
  if (typeof options === "function") {
    return { options }
  }

  if (!isPlainObject(options)) {
    throw authErrorDiagnostics.AUTH_C0036({ message: "`defineAuth()` expects an object or a callback." })
  }

  const viteHubOptions = options as {
    access?: unknown
    basePath?: unknown
    database?: unknown
    route?: unknown
    secondaryStorage?: unknown
  }
  const runtimeOption = Object.keys(options).find(key => authRuntimeOptionNames.has(key))
  if (runtimeOption) {
    throw authErrorDiagnostics.AUTH_C0037({ message: `\`defineAuth()\` ${runtimeOption} is resolved at runtime and cannot be defined in the Auth Definition.` })
  }

  if (typeof viteHubOptions.route !== "undefined" && viteHubOptions.route !== false) {
    throw authErrorDiagnostics.AUTH_C0038({ message: "`defineAuth()` route can only be `false` when provided." })
  }

  assertNoRuntimeOption(options)

  if (typeof viteHubOptions.basePath !== "undefined") {
    if (typeof viteHubOptions.basePath !== "string") {
      throw authErrorDiagnostics.AUTH_C0040({ message: "`defineAuth()` basePath must be a string." })
    }
    normalizeAuthBasePath(viteHubOptions.basePath)
  }

  const session = (options as { session?: unknown }).session
  if (isPlainObject(session) && typeof session.onRefresh !== "undefined" && typeof session.onRefresh !== "function") {
    throw authErrorDiagnostics.AUTH_C0041({ message: "`defineAuth()` session.onRefresh must be a function." })
  }

  validateAuthEvents(options.events)
  validateAuthDatabase(viteHubOptions.database)
  validateAuthSecondaryStorage(viteHubOptions.secondaryStorage)
  validateAuthAccess(viteHubOptions.access as AuthAccessConfiguration | undefined)
  // A callback resolves its options later, so ViteHub checks the preset again for each resolution.
  applyAuthPreset(options)

  return { options }
}
