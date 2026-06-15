import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthBetterAuthOptions,
  AuthDatabaseConfiguration,
  AuthDefinition,
  AuthDefinitionOptions,
  AuthSecondaryStorageConfiguration,
} from "./types.ts"

const authRuntimeOptionNames = new Set(["baseURL", "secret", "secrets"])
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

export function defineAuth<const TOptions extends AuthBetterAuthOptions>(
  options: AuthDefinitionOptions<TOptions>,
): AuthDefinition<AuthDefinitionOptions<TOptions>> {
  if (!isPlainObject(options)) {
    throw new TypeError("`defineAuth()` expects an object.")
  }

  const runtimeOption = Object.keys(options).find(key => authRuntimeOptionNames.has(key))
  if (runtimeOption) {
    throw new TypeError(`\`defineAuth()\` ${runtimeOption} is resolved at runtime and cannot be defined in the Auth Definition.`)
  }

  if (typeof options.route !== "undefined" && options.route !== false) {
    throw new TypeError("`defineAuth()` route can only be `false` when provided.")
  }

  if (typeof options.basePath !== "undefined") {
    normalizeAuthBasePath(options.basePath)
  }

  validateAuthDatabase(options.database)
  validateAuthSecondaryStorage(options.secondaryStorage)

  return { options }
}
