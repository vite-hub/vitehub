import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthAccessConfiguration,
  AuthBetterAuthOptions,
  AuthDatabaseConfiguration,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthDefinitionOptions,
  AuthResolvedDefinitionOptions,
  AuthSecondaryStorageConfiguration,
  AuthSignInConfiguration,
} from "./types.ts"

const authRuntimeOptionNames = new Set(["baseURL", "secret", "secrets"])
const accessRouteKeys = new Set(["authorize", "method", "route"])
const databaseReferenceKeys = new Set(["dedicated", "name"])
const secondaryStorageReferenceKeys = new Set(["store"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateNamedString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`\`defineAuth()\` ${label} must be a non-empty trimmed string.`)
  }
}

function validateAuthDatabase(value: AuthDatabaseConfiguration | undefined): void {
  if (typeof value === "undefined" || value === true) return
  if (!isPlainObject(value)) {
    throw new TypeError("`defineAuth()` database must be `true` or an inline object with `name`.")
  }

  const unknownKey = Object.keys(value).find(key => !databaseReferenceKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineAuth()\` database does not support the "${unknownKey}" option.`)
  }

  validateNamedString(value.name, "database.name")

  if (typeof value.dedicated !== "undefined" && typeof value.dedicated !== "boolean") {
    throw new TypeError("`defineAuth()` database.dedicated must be a boolean.")
  }
}

function validateAuthSecondaryStorage(value: AuthSecondaryStorageConfiguration | undefined): void {
  if (typeof value === "undefined" || value === true) return
  if (!isPlainObject(value)) {
    throw new TypeError("`defineAuth()` secondaryStorage must be `true` or an inline object with `store`.")
  }

  const unknownKey = Object.keys(value).find(key => !secondaryStorageReferenceKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineAuth()\` secondaryStorage does not support the "${unknownKey}" option.`)
  }

  validateNamedString(value.store, "secondaryStorage.store")
}

function validateStringValue(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`\`defineAuth()\` ${label} must be a non-empty string.`)
  }
}

function validateRouteValue(value: unknown, label: string): void {
  validateStringValue(value, label)
  if (typeof value === "string" && !value.startsWith("/")) {
    throw new TypeError(`\`defineAuth()\` ${label} must start with \`/\`.`)
  }
}

function validateAuthSignIn(value: AuthSignInConfiguration | undefined): void {
  if (typeof value === "undefined") return
  if (!isPlainObject(value)) {
    throw new TypeError("`defineAuth()` access.signIn must be an object.")
  }

  validateStringValue(value.provider, "access.signIn.provider")
  if (typeof value.callbackURL !== "undefined") validateStringValue(value.callbackURL, "access.signIn.callbackURL")
  if (typeof value.errorCallbackURL !== "undefined") validateStringValue(value.errorCallbackURL, "access.signIn.errorCallbackURL")
  if (typeof value.requestSignUp !== "undefined" && typeof value.requestSignUp !== "boolean") {
    throw new TypeError("`defineAuth()` access.signIn.requestSignUp must be a boolean.")
  }
  if (typeof value.scopes !== "undefined" && (!Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== "string"))) {
    throw new TypeError("`defineAuth()` access.signIn.scopes must be an array of strings.")
  }
}

function validateAuthAccessRoute(value: unknown, label: string): void {
  if (typeof value === "string") {
    validateRouteValue(value, label)
    return
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`\`defineAuth()\` ${label} must be a route string or route object.`)
  }

  const unknownKey = Object.keys(value).find(key => !accessRouteKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineAuth()\` ${label} does not support the "${unknownKey}" option.`)
  }

  validateRouteValue(value.route, `${label}.route`)
  if (typeof value.authorize !== "undefined" && typeof value.authorize !== "function") {
    throw new TypeError(`\`defineAuth()\` ${label}.authorize must be a function.`)
  }
  if (typeof value.method !== "undefined") validateStringValue(value.method, `${label}.method`)
}

function validateAuthAccess(value: AuthAccessConfiguration | undefined): void {
  if (typeof value === "undefined") return
  if (!isPlainObject(value)) {
    throw new TypeError("`defineAuth()` access must be an object.")
  }

  const access = value as AuthAccessConfiguration
  if (typeof access.routes !== "undefined") {
    if (!Array.isArray(access.routes)) {
      throw new TypeError("`defineAuth()` access.routes must be an array.")
    }
    access.routes.forEach((route, index) => validateAuthAccessRoute(route, `access.routes[${index}]`))
  }
  validateAuthSignIn(access.signIn)
}

export function defineAuth<const TOptions extends AuthBetterAuthOptions>(
  options: AuthDefinitionOptions<TOptions>,
): AuthDefinition<AuthDefinitionOptions<TOptions>>

export function defineAuth<const TOptions extends AuthResolvedDefinitionOptions>(
  options: AuthDefinitionResolver<TOptions>,
): AuthDefinition<AuthDefinitionResolver<TOptions>>

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
    throw new TypeError("`defineAuth()` expects an object or a callback.")
  }

  const viteHubOptions = options as {
    access?: unknown
    basePath?: unknown
    database?: unknown
    route?: unknown
    runtime?: unknown
    secondaryStorage?: unknown
  }
  const runtimeOption = Object.keys(options).find(key => authRuntimeOptionNames.has(key))
  if (runtimeOption) {
    throw new TypeError(`\`defineAuth()\` ${runtimeOption} is resolved at runtime and cannot be defined in the Auth Definition.`)
  }

  if (typeof viteHubOptions.route !== "undefined" && viteHubOptions.route !== false) {
    throw new TypeError("`defineAuth()` route can only be `false` when provided.")
  }

  if (
    typeof viteHubOptions.runtime !== "undefined"
    && typeof viteHubOptions.runtime !== "function"
    && !isPlainObject(viteHubOptions.runtime)
  ) {
    throw new TypeError("`defineAuth()` runtime must be an object or a function.")
  }

  if (typeof viteHubOptions.basePath !== "undefined") {
    if (typeof viteHubOptions.basePath !== "string") {
      throw new TypeError("`defineAuth()` basePath must be a string.")
    }
    normalizeAuthBasePath(viteHubOptions.basePath)
  }

  validateAuthDatabase(viteHubOptions.database as AuthDatabaseConfiguration | undefined)
  validateAuthSecondaryStorage(viteHubOptions.secondaryStorage as AuthSecondaryStorageConfiguration | undefined)
  validateAuthAccess(viteHubOptions.access as AuthAccessConfiguration | undefined)

  return { options }
}
