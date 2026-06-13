import { readFileSync } from "node:fs"

import { findIdentifierCalls, findMatching, splitTopLevel } from "@vite-hub/internal/source-scanner"

import { discoverAuthDefinition } from "./discovery.ts"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthModuleOptions,
  ResolvedAuthDatabaseConfiguration,
  ResolvedAuthSecondaryStorageConfiguration,
  ResolvedAuthViteConfig,
} from "./types.ts"

export { normalizeAuthBasePath } from "./shared.ts"

function readDefinitionObjectBody(file: string): string | undefined {
  const source = readFileSync(file, "utf8")
  const calls = findIdentifierCalls(source, "defineAuth")
  const call = calls.find(item => /(?:^|[;\n])\s*export\s+default\s*$/.test(source.slice(Math.max(0, item.start - 100), item.start)))
    || calls[0]
  const argument = call?.arguments[0]?.trim()
  if (!argument?.startsWith("{")) return
  const closeIndex = findMatching(argument, 0, "{", "}")
  return typeof closeIndex === "undefined" ? undefined : argument.slice(1, closeIndex)
}

function objectLiteralBody(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed?.startsWith("{")) return
  const closeIndex = findMatching(trimmed, 0, "{", "}")
  return typeof closeIndex === "undefined" ? undefined : trimmed.slice(1, closeIndex)
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|["'`]([^"'`]+)["'`])\s*(?::|$)/.exec(entry)
  return match?.[1] || match?.[2]
}

function readEntryValue(entry: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_$][\w$]*|["'`][^"'`]+["'`])\s*:/.exec(entry)
  return match ? entry.slice(match[0].length).trim() : undefined
}

function readObjectEntries(body: string | undefined): Array<{ key: string; value: string | undefined }> {
  if (!body) return []
  return splitTopLevel(body)
    .filter(entry => entry.length > 0)
    .map((entry) => ({ key: readEntryKey(entry) ?? "", value: readEntryValue(entry) }))
}

function readObjectPropertyValue(body: string | undefined, property: string): string | undefined {
  return readObjectEntries(body).find(entry => entry.key === property)?.value
}

function hasObjectProperty(body: string | undefined, property: string): boolean {
  return readObjectEntries(body).some(entry => entry.key === property)
}

function readStaticStringLiteral(expression: string | undefined): string | undefined {
  const trimmed = expression?.trim()
  if (!trimmed) return
  return /^["']([^"']*)["']$/.exec(trimmed)?.[1]
    ?? /^`([^`$]*)`$/.exec(trimmed)?.[1]
}

function readStaticBooleanLiteral(expression: string | undefined): boolean | undefined {
  const trimmed = expression?.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
}

function readStaticStringProperty(body: string | undefined, property: string, label: string): string | undefined {
  if (!hasObjectProperty(body, property)) return
  const value = readStaticStringLiteral(readObjectPropertyValue(body, property))
  if (typeof value === "undefined") {
    throw new TypeError(`\`defineAuth()\` ${label} must be an inline string literal.`)
  }
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`\`defineAuth()\` ${label} must be a non-empty trimmed string.`)
  }
  return value
}

function readStaticBooleanProperty(body: string | undefined, property: string, label: string): boolean | undefined {
  if (!hasObjectProperty(body, property)) return
  const value = readStaticBooleanLiteral(readObjectPropertyValue(body, property))
  if (typeof value === "undefined") {
    throw new TypeError(`\`defineAuth()\` ${label} must be an inline boolean literal.`)
  }
  return value
}

function assertOnlyObjectKeys(body: string | undefined, allowed: Set<string>, label: string): void {
  const unknownEntry = readObjectEntries(body).find(entry => !entry.key || !allowed.has(entry.key))
  if (!unknownEntry) return
  if (!unknownEntry.key) {
    throw new TypeError(`\`defineAuth()\` ${label} must use static object keys.`)
  }
  throw new TypeError(`\`defineAuth()\` ${label} does not support the "${unknownEntry.key}" option.`)
}

function assertStaticObjectKeys(body: string | undefined, label: string): void {
  if (readObjectEntries(body).some(entry => !entry.key)) {
    throw new TypeError(`\`defineAuth()\` ${label} must use static object keys.`)
  }
}

function readAuthRouteConfig(body: string | undefined): false | string {
  const basePath = normalizeAuthBasePath(readStaticStringProperty(body, "basePath", "basePath"))
  if (!hasObjectProperty(body, "route")) return basePath

  const route = readStaticBooleanLiteral(readObjectPropertyValue(body, "route"))
  if (route === false) return false
  throw new TypeError("`defineAuth()` route can only be `false` when provided.")
}

function readAuthDatabaseConfig(body: string | undefined): ResolvedAuthDatabaseConfiguration {
  if (!hasObjectProperty(body, "database")) return { mode: "default" }

  const expression = readObjectPropertyValue(body, "database")?.trim()
  if (expression === "true") return { mode: "default" }
  if (expression === "false") {
    throw new TypeError("`defineAuth()` database cannot be `false`.")
  }

  const database = objectLiteralBody(expression)
  if (typeof database === "undefined") {
    throw new TypeError("`defineAuth()` database must be `true` or an inline object with `name`.")
  }

  assertOnlyObjectKeys(database, new Set(["dedicated", "name"]), "database")

  return {
    dedicated: readStaticBooleanProperty(database, "dedicated", "database.dedicated") ?? false,
    mode: "named",
    name: readStaticStringProperty(database, "name", "database.name") ?? (() => {
      throw new TypeError("`defineAuth()` database.name is required when database is an object.")
    })(),
  }
}

function readAuthSecondaryStorageConfig(body: string | undefined): false | ResolvedAuthSecondaryStorageConfiguration {
  if (!hasObjectProperty(body, "secondaryStorage")) return false

  const expression = readObjectPropertyValue(body, "secondaryStorage")?.trim()
  if (expression === "true") return { mode: "default" }
  if (expression === "false") {
    throw new TypeError("`defineAuth()` secondaryStorage cannot be `false`.")
  }

  const secondaryStorage = objectLiteralBody(expression)
  if (typeof secondaryStorage === "undefined") {
    throw new TypeError("`defineAuth()` secondaryStorage must be `true` or an inline object with `store`.")
  }

  assertOnlyObjectKeys(secondaryStorage, new Set(["store"]), "secondaryStorage")

  return {
    mode: "named",
    store: readStaticStringProperty(secondaryStorage, "store", "secondaryStorage.store") ?? (() => {
      throw new TypeError("`defineAuth()` secondaryStorage.store is required when secondaryStorage is an object.")
    })(),
  }
}

export function resolveAuthViteConfig(options?: AuthModuleOptions, rootDir: string = process.cwd()): ResolvedAuthViteConfig | undefined {
  if (options === false) return

  const definition = discoverAuthDefinition(rootDir)
  if (!definition) return

  const body = readDefinitionObjectBody(definition.handler)
  if (typeof body === "undefined") {
    throw new TypeError("`defineAuth()` options must be an inline object literal.")
  }
  assertStaticObjectKeys(body, "options")
  const basePath = normalizeAuthBasePath(readStaticStringProperty(body, "basePath", "basePath"))

  return {
    basePath,
    database: readAuthDatabaseConfig(body),
    definition,
    rootDir,
    route: readAuthRouteConfig(body),
    secondaryStorage: readAuthSecondaryStorageConfig(body),
  }
}
