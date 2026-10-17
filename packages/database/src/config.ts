import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createGeneratedDefinitionPath,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizeSuffixDefinitionName,
  sanitizeDefinitionFilename,
} from "@vite-hub/internal/definition-catalog"
import { findIdentifierCalls, findMatching, splitTopLevel } from "@vite-hub/internal/source-scanner"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { createRuntimeEnvConfigValue, resolveConfigValue, withConfigValueFallback } from "./config-value.ts"
import { cloudflareOptions, mergeCloudflareConfig, resolveCloudflareD1Binding, resolveCloudflareD1BindingName, resolveCloudflareHyperdriveBindingName } from "./internal/cloudflare.ts"

import type {
  CloudflareD1BindingConfig,
  CloudflareD1Projection,
  CloudflareD1HttpConfig,
  DatabaseConfigValue,
  DatabaseConnectionConfig,
  DatabaseDialect,
  DBModulePublicOptions,
  DiscoveredDatabaseDefinition,
  ResolvedCloudflareD1BindingConfig,
  ResolvedCloudflareHyperdriveConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
} from "./types.ts"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveDatabaseContributionTargets } from "./contributions.ts"

import type { CollectedDatabaseContribution } from "./contributions.ts"

export { resolveConfigValue } from "./config-value.ts"
export { resolveDefaultDatabase, type DefaultDatabaseResolution } from "./contributions.ts"

/** Serialize generated registries without invoking the legacy __proto__ setter. */
export function serializeGeneratedRegistry(value: unknown): string {
  return JSON.stringify(value).replace(/"__proto__":/g, '["__proto__"]:')
}

const configFilePattern = /^config\.(?:c|m)?[jt]s$/i
const viteDatabaseSuffixPattern = /\.database\.(?:c|m)?[jt]s$/i

function readDefinitionObjectBody(file: string, exact = false) {
  const source = readFileSync(file, "utf8")
  const calls = findIdentifierCalls(source, "defineDatabase")
  const call = calls.find(item => /(?:^|[;\n])\s*export\s+default\s*$/.test(source.slice(Math.max(0, item.start - 100), item.start)))
    || calls[0]
  const argument = call?.arguments[0]?.trim()
  if (!argument?.startsWith("{")) return
  const closeIndex = findMatching(argument, 0, "{", "}")
  return closeIndex === undefined || (exact && argument.slice(closeIndex + 1).trim()) ? undefined : argument.slice(1, closeIndex)
}

function objectLiteralBody(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed?.startsWith("{")) return
  const closeIndex = findMatching(trimmed, 0, "{", "}")
  return closeIndex === undefined ? undefined : trimmed.slice(1, closeIndex)
}

function stripLeadingEntryComments(entry: string) {
  return entry.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["']|\[\s*["']([^"']+)["']\s*\])\s*(?::|$)/.exec(stripLeadingEntryComments(entry))
  return match?.[1] || match?.[2] || match?.[3]
}

function readEntryValue(entry: string): string | undefined {
  const normalized = stripLeadingEntryComments(entry)
  const match = /^\s*(?:[A-Za-z_$][\w$]*|["'][^"']+["']|\[\s*["'][^"']+["']\s*\])\s*:/.exec(normalized)
  return match ? normalized.slice(match[0].length).trim() : undefined
}

function readObjectPropertyValue(body: string | undefined, property: string): string | undefined {
  if (!body) return
  for (const entry of splitTopLevel(body)) {
    if (readEntryKey(entry) !== property) continue
    return readEntryValue(entry)
  }
}

function readObjectKeys(body: string | undefined) {
  if (!body) return []
  return [...new Set(splitTopLevel(body).map(readEntryKey).filter((key): key is string => Boolean(key)))]
}

export interface StaticDatabaseSchema {
  /** False when the schema has entries the source cannot show, such as an imported schema or a spread. */
  complete: boolean
  tableNames: string[]
}

/** Reads the keys of a literal `schema: { ... }` without loading the Definition. */
export function readStaticDatabaseSchema(file: string): StaticDatabaseSchema {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "schema"))
  if (body === undefined) return { complete: false, tableNames: [] }
  const entries = splitTopLevel(body).map(stripLeadingEntryComments).filter(entry => entry.trim())
  return {
    complete: entries.every(entry => !entry.trimStart().startsWith("...") && readEntryKey(entry)),
    tableNames: readObjectKeys(body),
  }
}

function readConfigValue(body: string | undefined, property: string): DatabaseConfigValue | undefined {
  const expression = readObjectPropertyValue(body, property)
  if (!expression) return
  const quoted = readStaticStringLiteral(expression)
  if (typeof quoted !== "undefined") return quoted
  const declaration = readRuntimeEnvDeclaration(expression)
  if (declaration) return declaration
  const fallbackParts = expression.split(/\s*(?:\|\||\?\?)\s*/)
  if (fallbackParts.length === 1) {
    const envName = readProcessEnvName(fallbackParts[0]!)
    if (envName) return createRuntimeEnvConfigValue([envName])
  }
  if (fallbackParts.length === 2) {
    const envName = readProcessEnvName(fallbackParts[0]!)
    const fallback = fallbackParts[1]!
    if (!envName) return
    const fallbackEnvName = readProcessEnvName(fallback)
    if (fallbackEnvName) return createRuntimeEnvConfigValue([envName, fallbackEnvName])
    const staticFallback = readStaticStringLiteral(fallback)
    if (typeof staticFallback !== "undefined") return createRuntimeEnvConfigValue([envName], staticFallback)
  }
}

function readRuntimeEnvDeclaration(expression: string): DatabaseConfigValue | undefined {
  const match = /^env\s*\((.*)\)$/s.exec(expression.trim())
  const body = objectLiteralBody(match?.[1])
  if (!body) return
  const source = readObjectPropertyValue(body, "source")?.trim()
  const sourceMatch = /^env\.source\s*\((.*)\)$/s.exec(source || "")
  if (!sourceMatch) return
  const sourceValue = sourceMatch[1]!.trim()
  const singleName = readStaticStringLiteral(sourceValue)
  const names = typeof singleName !== "undefined"
    ? [singleName]
    : /^\[(.*)\]$/s.exec(sourceValue)?.[1]
        ?.split(",")
        .map(value => readStaticStringLiteral(value.trim()))
  if (!names?.length || names.some(name => typeof name === "undefined" || !name.trim())) return
  const defaultValue = readStaticStringLiteral(readObjectPropertyValue(body, "default")?.trim() || "")
  return createRuntimeEnvConfigValue(names as string[], defaultValue)
}

const staticStringEscapes = new Map([["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"]])

function readStaticStringLiteral(expression: string): string | undefined {
  const quote = expression[0]
  if (expression.length < 2 || (quote !== "'" && quote !== '"') || expression.at(-1) !== quote) return
  let value = ""
  for (let index = 1; index < expression.length - 1; index += 1) {
    const char = expression[index]!
    if (char === quote || char === "\n" || char === "\r") return
    if (char !== "\\") {
      value += char
      continue
    }
    const escaped = expression[++index]!
    if (index >= expression.length - 1) return
    if (escaped === "\r") {
      if (expression[index + 1] === "\n") index += 1
      continue
    }
    if (escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") continue
    if (escaped === "u" && expression[index + 1] === "{") {
      const match = /^\{([\da-f]+)\}/i.exec(expression.slice(index + 1, -1))
      const codePoint = match ? Number.parseInt(match[1]!, 16) : Number.NaN
      if (!match || codePoint > 0x10FFFF) return
      value += String.fromCodePoint(codePoint)
      index += match[0].length
      continue
    }
    if (escaped === "u" || escaped === "x") {
      const length = escaped === "u" ? 4 : 2
      const hex = expression.slice(index + 1, index + 1 + length)
      if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) return
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += length
      continue
    }
    if (/\d/.test(escaped) && (escaped !== "0" || /\d/.test(expression[index + 1] || ""))) return
    value += escaped === "0" ? "\0" : staticStringEscapes.get(escaped) ?? escaped
  }
  return value
}

function readProcessEnvName(expression: string) {
  return /^process\.env\.([A-Za-z_$][\w$]*)$/.exec(expression)?.[1]
    ?? /^process\.env\[['"]([A-Za-z_$][\w$]*)['"]\]$/.exec(expression)?.[1]
}

function readStringValue(body: string | undefined, property: string): string | undefined {
  const value = readConfigValue(body, property)
  const resolved = resolveConfigValue(value)
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

type DefinitionCloudflareResource = CloudflareD1Projection["resource"]

function readDefinitionCloudflareResource(expression: string | undefined): DefinitionCloudflareResource {
  if (expression?.trim() === "undefined") return "inherited"
  const body = objectLiteralBody(expression)
  if (body === undefined) return "opaque"
  let resource: DefinitionCloudflareResource = "inherited"
  for (const property of splitTopLevel(body)) {
    const normalized = stripLeadingEntryComments(property)
    if (!normalized.trim()) continue
    const key = readEntryKey(normalized)
    if (normalized.trimStart().startsWith("...") || !key) return "opaque"
    if (key !== "databaseId" && key !== "databaseName") continue
    if (readEntryValue(normalized)?.trim() === "undefined") continue
    if (readConfigValue(body, key) === undefined) return "opaque"
    resource = "configured"
  }
  return resource
}

function readDefinitionCloudflareConfig(file: string): { resource: DefinitionCloudflareResource, value?: CloudflareD1BindingConfig } {
  const definitionBody = readDefinitionObjectBody(file)
  const definitionEntries = definitionBody === undefined
    ? []
    : splitTopLevel(definitionBody).map(stripLeadingEntryComments)
  const cloudflareEntries = definitionEntries.filter(entry => readEntryKey(entry) === "cloudflare")
  const expression = cloudflareEntries.length ? readEntryValue(cloudflareEntries.at(-1)!) : undefined
  let resource: DefinitionCloudflareResource = definitionBody === undefined ? "opaque" : "inherited"
  for (const entry of definitionEntries) {
    if (!entry.trim()) continue
    const key = readEntryKey(entry)
    if (entry.trimStart().startsWith("...") || !key) {
      resource = "opaque"
    }
    else if (key === "cloudflare") {
      resource = readDefinitionCloudflareResource(readEntryValue(entry))
    }
  }
  const body = objectLiteralBody(expression)
  if (resource === "opaque") {
    if (cloudflareEntries.length && expression?.trim() !== "undefined") return { resource, value: {} }
    return { resource }
  }
  if (body === undefined) return { resource }
  const httpExpression = readObjectPropertyValue(body, "http")?.trim()
  const httpBody = objectLiteralBody(httpExpression)
  const http = httpExpression === "true"
    ? true
    : httpBody
      ? {
          authToken: readConfigValue(httpBody, "authToken"),
          url: readConfigValue(httpBody, "url"),
        } satisfies CloudflareD1HttpConfig
      : undefined
  const value: CloudflareD1BindingConfig = {
    binding: readStringValue(body, "binding"),
    databaseId: readConfigValue(body, "databaseId"),
    databaseName: readConfigValue(body, "databaseName"),
    migrationsTable: readStringValue(body, "migrationsTable"),
    previewDatabaseId: readConfigValue(body, "previewDatabaseId"),
  }
  if (http && (http === true || http.authToken || http.url)) value.http = http
  return {
    resource,
    ...(Object.values(value).some(item => typeof item !== "undefined") ? { value } : {}),
  }
}

// Partial scanner results cannot prove HTTP stays enabled after runtime spreads.
export function isStaticD1HttpDefinition(file: string) {
  if (!existsSync(file)) return false
  const definitionBody = readDefinitionObjectBody(file, true)
  if (definitionBody === undefined) return false
  const definitionEntries = splitTopLevel(definitionBody).filter(entry => entry.trim())
  if (definitionEntries.some(entry => !readEntryKey(entry))) return false
  const cloudflareEntries = definitionEntries.filter(entry => readEntryKey(entry) === "cloudflare")
  if (cloudflareEntries.length !== 1) return false
  const expression = readEntryValue(cloudflareEntries[0]!)?.trim()
  const body = objectLiteralBody(expression)
  if (body === undefined || expression !== `{${body}}`) return false
  const entries = splitTopLevel(body).filter(entry => entry.trim())
  if (entries.some(entry => !readEntryKey(entry))) return false
  const httpEntries = entries.filter(entry => readEntryKey(entry) === "http")
  if (httpEntries.length !== 1) return false
  const http = readEntryValue(httpEntries[0]!)?.trim()
  const httpBody = objectLiteralBody(http)
  return http === "true" || (httpBody !== undefined && http === `{${httpBody}}`)
}

function readDefinitionConnectionConfig(file: string) {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "connection"))
  if (!body) return
  const value = {
    authToken: readConfigValue(body, "authToken"),
    url: readConfigValue(body, "url"),
  }
  return Object.values(value).some(item => typeof item !== "undefined") ? value : undefined
}

/** Reads the static `dialect` of a Database Definition. A Definition without one uses SQLite. */
export function readDatabaseDefinitionDialect(file: string): DatabaseDialect {
  const expression = readObjectPropertyValue(readDefinitionObjectBody(file), "dialect")?.trim()
  if (expression === undefined) return "sqlite"
  const dialect = readStaticStringLiteral(expression)
  if (dialect === "sqlite" || dialect === "postgresql") return dialect
  throw databaseErrorDiagnostics.DATABASE_C0011({ message: `[vitehub] Database definition "${file}" must set \`dialect\` to the string literal "sqlite" or "postgresql".` })
}

function readDefinitionHyperdriveConfig(file: string, name: string): ResolvedCloudflareHyperdriveConfig {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "cloudflare"))
  const config: ResolvedCloudflareHyperdriveConfig = { binding: resolveCloudflareHyperdriveBindingName(name, readStringValue(body, "binding")) }
  const hyperdriveId = readConfigValue(body, "hyperdriveId")
  if (hyperdriveId !== undefined) config.hyperdriveId = hyperdriveId
  return config
}

type FoundDatabaseDefinition = Omit<DiscoveredDatabaseDefinition, "schemaSources">

function createDatabaseDefinition(source: string, file: string, name: string, mode: "default" | "named"): FoundDatabaseDefinition {
  const configuredName = readStringValue(readDefinitionObjectBody(file), "name")?.trim() || "default"
  if (configuredName !== name) {
    throw databaseErrorDiagnostics.DATABASE_C0001({ message: `[vitehub] Database definition "${file}" must set \`name: ${JSON.stringify(name)}\` to match its discovered identity.` })
  }
  return {
    handler: file,
    mode,
    name,
    source,
    tableNames: readStaticDatabaseSchema(file).tableNames,
  }
}

function discoverServerDatabases(serverDir: string) {
  return discoverDefinitions<FoundDatabaseDefinition>("database", [
    createDirectoryDefinitionSource("server-database-default", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        return dirname(file).replace(/\\/g, "/") === directory.replace(/\\/g, "/") ? "default" : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("server-database-default", file, name, "default"),
    }),
    createDirectoryDefinitionSource("server-databases-named", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        const name = relative(directory, dirname(file)).replace(/\\/g, "/")
        return name && name !== "." ? name : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("server-databases-named", file, name, "named"),
    }),
  ])
}

function discoverViteDatabases(rootDir: string) {
  const defaultFile = resolve(rootDir, "src", "database.ts")
  const defaultDefinitions = existsSync(defaultFile)
    ? [createDatabaseDefinition("vite-database-default", defaultFile, "default", "default")]
    : []
  const suffixDefinitions = discoverDefinitions<FoundDatabaseDefinition>("database", [
    createSuffixDefinitionSource("vite-database-suffix", [rootDir], viteDatabaseSuffixPattern, (root, file) => {
      const name = normalizeSuffixDefinitionName(root, file, viteDatabaseSuffixPattern, { stripPrefix: "src/" })
      return name === "database" ? undefined : name
    }, {
      createDefinition: ({ file, name }) => createDatabaseDefinition("vite-database-suffix", file, name, "named"),
    }),
  ])
  return [...defaultDefinitions, ...suffixDefinitions]
}

const schemaOnlyDefinitionKeys = new Set(["name", "schema"])

/** Lists the database options that a Definition sets, or returns `undefined` when ViteHub cannot read them. */
function readDefinitionOptionKeys(file: string): Set<string> | undefined {
  const body = readDefinitionObjectBody(file)
  if (body === undefined) return
  const keys = new Set<string>()
  for (const entry of splitTopLevel(body)) {
    const normalized = stripLeadingEntryComments(entry)
    if (!normalized.trim()) continue
    const key = readEntryKey(normalized)
    if (normalized.trimStart().startsWith("...") || !key) return
    if (!schemaOnlyDefinitionKeys.has(key)) keys.add(key)
  }
  return keys
}

/** Reports whether a Definition can set database options. Opaque Definitions count because ViteHub cannot read them. */
function configuresDatabase(file: string) {
  const keys = readDefinitionOptionKeys(file)
  return keys === undefined || keys.size > 0
}

function listDefinitionFiles(definitions: Array<{ handler: string }>) {
  return definitions.map(definition => `  - ${definition.handler}`)
}

/**
 * Merges the Definitions of one database. Layer 0 is the application. Higher layers are Nuxt layers in priority order.
 * Options come from the application when it sets them, and otherwise from the one layer that sets them.
 * An application table replaces a layer table with the same key. Two layers cannot declare the same table.
 */
function mergeLayerDefinitions(name: string, entries: Array<{ definition: FoundDatabaseDefinition, layer: number }>): DiscoveredDatabaseDefinition {
  const ordered = [...entries].sort((left, right) => left.layer - right.layer)
  const sameLayer = ordered.find((entry, index) => index > 0 && entry.layer === ordered[index - 1]!.layer)
  if (sameLayer) {
    const duplicates = ordered.filter(entry => entry.layer === sameLayer.layer).map(entry => entry.definition)
    throw databaseErrorDiagnostics.DATABASE_C0003({ message: [
      name === "default"
        ? "[vitehub] Only one default database definition is allowed."
        : `[vitehub] Only one definition is allowed for database "${name}".`,
      ...listDefinitionFiles(duplicates),
    ].join("\n") })
  }

  const app = ordered[0]!.layer === 0 ? ordered[0]!.definition : undefined
  const appConfigures = app !== undefined && configuresDatabase(app.handler)
  const layers = ordered.filter(entry => entry.layer > 0).map(entry => entry.definition)
  const configuringLayers = layers.filter(definition => configuresDatabase(definition.handler))
  // The application Definition supplies every option when it sets one, so a layer option that it does not repeat would be lost.
  if (app && appConfigures) {
    const appOptions = readDefinitionOptionKeys(app.handler)
    for (const layer of configuringLayers) {
      const layerOptions = readDefinitionOptionKeys(layer.handler)
      if (!appOptions || !layerOptions) {
        throw databaseErrorDiagnostics.DATABASE_C0008({ message: [
          `[vitehub] The application definition of database "${name}" sets options, so it replaces the options of its Nuxt layers.`,
          "ViteHub cannot read the options of these definitions:",
          ...listDefinitionFiles([app, layer]),
          "Pass an object literal to defineDatabase() in both files, or keep every option in one of them.",
        ].join("\n") })
      }
      const missing = [...layerOptions].filter(key => !appOptions.has(key))
      if (!missing.length) continue
      const options = missing.map(key => `\`${key}\``).join(", ")
      throw databaseErrorDiagnostics.DATABASE_C0008({ message: [
        `[vitehub] The application definition of database "${name}" sets options, so it replaces the options of its Nuxt layers.`,
        `It does not set ${options}, which a layer sets:`,
        ...listDefinitionFiles([app, layer]),
        `Set ${options} in the application definition too, or move all options to the layer.`,
      ].join("\n") })
    }
  }
  if (!appConfigures && configuringLayers.length > 1) {
    throw databaseErrorDiagnostics.DATABASE_C0008({ message: [
      `[vitehub] More than one Nuxt layer sets options for database "${name}":`,
      ...listDefinitionFiles(configuringLayers),
      `Keep the options in one layer, or set them in the application definition of database "${name}".`,
    ].join("\n") })
  }

  const appTables = new Set(app?.tableNames)
  const tableOwners = new Map<string, FoundDatabaseDefinition>()
  for (const definition of layers) {
    for (const tableName of definition.tableNames ?? []) {
      const owner = tableOwners.get(tableName)
      if (owner && !appTables.has(tableName)) {
        throw databaseErrorDiagnostics.DATABASE_C0009({ message: [
          `[vitehub] More than one Nuxt layer declares table "${tableName}" in database "${name}":`,
          ...listDefinitionFiles([owner, definition]),
          `Rename one table, or declare "${tableName}" in the application definition to replace both.`,
        ].join("\n") })
      }
      tableOwners.set(tableName, definition)
    }
  }

  const owner = (appConfigures ? app : configuringLayers[0]) ?? app ?? layers[0]!
  // Later sources take precedence, so the application comes last.
  const schemaSources = [...ordered].reverse().map(({ definition }) => ({ handler: definition.handler, tableNames: (definition.tableNames ?? []) }))
  return {
    ...owner,
    schemaSources,
    tableNames: [...new Set(ordered.flatMap(({ definition }) => (definition.tableNames ?? [])))],
  }
}

export function discoverDatabaseDefinitions(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredDatabaseDefinition[] {
  const serverDirs = options.serverDirs ?? [resolve(rootDir, "server")]
  const found = [
    ...serverDirs.flatMap((serverDir, layer) => discoverServerDatabases(serverDir).map(definition => ({ definition, layer }))),
    ...discoverViteDatabases(rootDir).map(definition => ({ definition, layer: 0 })),
  ].filter((entry, index, all) => all.findIndex(item => item.definition.handler === entry.definition.handler) === index)
  const defaults = found.filter(entry => entry.definition.mode === "default")
  const named = found.filter(entry => entry.definition.mode === "named")
  if (defaults.length && named.length) {
    throw databaseErrorDiagnostics.DATABASE_C0002({ message: [
      "[vitehub] Database definitions must use either one default database or all named databases, not both.",
      ...listDefinitionFiles(found.map(entry => entry.definition)),
    ].join("\n") })
  }
  const byName = new Map<string, typeof found>()
  for (const entry of found) {
    const entries = byName.get(entry.definition.name) ?? []
    entries.push(entry)
    byName.set(entry.definition.name, entries)
  }
  return [...byName].map(([name, entries]) => mergeLayerDefinitions(name, entries))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function isWithinDirectory(directory: string, file: string) {
  const path = relative(directory, file)
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path)
}

/** Keeps migrations in the application, also when a Nuxt layer owns the database options. */
function getDefaultMigrationsDir(rootDir: string, definition: DiscoveredDatabaseDefinition, serverDirs: string[] | undefined) {
  const [appServerDir, ...layerServerDirs] = serverDirs ?? []
  const ownedByLayer = appServerDir !== undefined && !isWithinDirectory(appServerDir, definition.handler)
    && layerServerDirs.some(directory => isWithinDirectory(directory, definition.handler))
  const directory = ownedByLayer
    ? resolve(appServerDir, "databases", ...(definition.mode === "named" ? [definition.name] : []))
    : dirname(definition.handler)
  return relative(rootDir, resolve(directory, "migrations"))
}

function normalizeCloudflareConfig(
  value: CloudflareD1BindingConfig | undefined,
  name: string,
  migrationsDir: string,
): ResolvedCloudflareD1BindingConfig | undefined {
  if (!value) return
  return {
    binding: resolveCloudflareD1BindingName(name, value.binding),
    ...(typeof value.databaseId !== "undefined" ? { databaseId: value.databaseId } : {}),
    ...(typeof value.http !== "undefined" ? { http: value.http } : {}),
    ...(typeof value.previewDatabaseId !== "undefined" ? { previewDatabaseId: value.previewDatabaseId } : {}),
    ...(typeof value.databaseName !== "undefined" ? { databaseName: value.databaseName } : {}),
    migrationsDir,
    ...(typeof value.migrationsTable === "string" && value.migrationsTable.trim() ? { migrationsTable: value.migrationsTable.trim() } : {}),
  }
}

function getDefaultConnection(name: string) {
  return {
    authToken: undefined,
    url: name === "default" ? "file:.vitehub/data/database/sqlite.db" : `file:.vitehub/data/database/${name}.sqlite.db`,
  }
}

function hasConnectionValue(value: DatabaseConfigValue | undefined) {
  return typeof value === "string" ? Boolean(value.trim()) : typeof value !== "undefined"
}

function selectConnectionValue(value: DatabaseConfigValue | undefined, fallback: DatabaseConfigValue | undefined) {
  const resolved = resolveConfigValue(value)
  if (typeof resolved === "string" && resolved.trim()) return value
  return typeof value === "object" && typeof fallback !== "undefined" ? value : fallback
}

function resolveDefinitionConnection(file: string, name: string, fallback?: DatabaseConnectionConfig) {
  const definition = readDefinitionConnectionConfig(file)
  const url = selectConnectionValue(definition?.url, fallback?.url)
  if (!hasConnectionValue(url)) return getDefaultConnection(name)
  return {
    authToken: hasConnectionValue(definition?.authToken) ? definition?.authToken : fallback?.authToken,
    url,
  }
}

function createGeneratedSchemaFile(rootDir: string, name: string) {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: `schema/${sanitizeDefinitionFilename(name)}.ts`,
    productName: "database",
  })
}

function createGeneratedDrizzleConfigFile(rootDir: string, name: string) {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: `drizzle/${sanitizeDefinitionFilename(name)}.config.ts`,
    productName: "database",
  })
}

export function resolveDBViteConfig(
  options?: DBModulePublicOptions,
  rootDir = process.cwd(),
  context: {
    /** Tables that Vite plugins contribute. See `collectDatabaseContributions()`. */
    contributions?: readonly CollectedDatabaseContribution[]
    provisionRoot?: string
    serverDirs?: string[]
  } = {},
): ResolvedDBViteConfig | undefined {
  if (options === false) return

  const definitions = discoverDatabaseDefinitions(rootDir, context)
  if (!definitions.length) {
    // Contributed tables need a Database, so this fails when a plugin contributes tables.
    resolveDatabaseContributionTargets([], context.contributions ?? [])
    return
  }

  const databases: Record<string, ResolvedDrizzleDatabaseConfig> = Object.create(null)
  const cloudflareProjections: Record<string, CloudflareD1Projection> = Object.create(null)
  const generatedDrizzleConfigFilesByDatabase: Record<string, string> = Object.create(null)
  const generatedSchemaFilesByDatabase: Record<string, string> = Object.create(null)
  const provisionState = readProvisionStateSync(context.provisionRoot ?? rootDir)
  for (const definition of definitions) {
    const migrationsDir = getDefaultMigrationsDir(rootDir, definition, context.serverDirs)
    const generatedSchemaFile = createGeneratedSchemaFile(rootDir, definition.name)
    generatedDrizzleConfigFilesByDatabase[definition.name] = createGeneratedDrizzleConfigFile(rootDir, definition.name)
    generatedSchemaFilesByDatabase[definition.name] = generatedSchemaFile
    // Postgres Definitions own their connection. SQLite, libSQL, and D1 integration defaults do not apply.
    if (readDatabaseDefinitionDialect(definition.handler) === "postgresql") {
      const url = readDefinitionConnectionConfig(definition.handler)?.url
      databases[definition.name] = {
        connection: url === undefined ? {} : { url },
        dialect: "postgresql",
        drizzle: {},
        generatedSchemaFile,
        hyperdrive: readDefinitionHyperdriveConfig(definition.handler, definition.name),
        migrationsDir,
        mode: definition.mode,
        name: definition.name,
        orm: "drizzle",
      }
      continue
    }
    const definitionCloudflare = readDefinitionCloudflareConfig(definition.handler)
    const projection: CloudflareD1Projection = { resource: definitionCloudflare.resource }
    cloudflareProjections[definition.name] = projection
    const cloudflare = normalizeCloudflareConfig(mergeCloudflareConfig(cloudflareOptions(options), definitionCloudflare.value), definition.name, migrationsDir)
    if (cloudflare) {
      if (definitionCloudflare.resource !== "opaque" && definition.name !== "default" && !definitionCloudflare.value?.binding) {
        cloudflare.binding = resolveCloudflareD1BindingName(definition.name, undefined)
      }
      projection.provisionedId = provisionState.cloudflare?.d1?.[definition.name]
      if (definitionCloudflare.resource !== "opaque") {
        cloudflare.databaseId = withConfigValueFallback(cloudflare.databaseId, projection.provisionedId)
        const native = resolveCloudflareD1Binding({ ...cloudflare, database: definition.name }, { provisionState })
        if (native.d1Database) projection.binding = native.bindingName
      }
    }
    databases[definition.name] = {
      cloudflare,
      connection: resolveDefinitionConnection(definition.handler, definition.name, options?.connection),
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile,
      migrationsDir,
      mode: definition.mode,
      name: definition.name,
      orm: "drizzle",
    }
  }

  const tableContributionsByDatabase = resolveDatabaseContributionTargets(
    definitions.map(definition => definition.name),
    context.contributions ?? [],
    Object.fromEntries(definitions.map(definition => [definition.name, databases[definition.name]!.dialect])),
  )
  const definitionDefaults: ResolvedDBViteConfig["definitionDefaults"] = { cloudflareProjections }
  if (options && options.driver === "d1") definitionDefaults.cloudflare = cloudflareOptions(options) ?? {}
  if (options && options.connection) definitionDefaults.connection = options.connection
  return {
    databaseNames: definitions.map(definition => definition.name),
    databases,
    definitionDefaults,
    definitions,
    generatedDrizzleConfigFile: createGeneratedDefinitionPath(rootDir, {
      fileName: "drizzle.config.ts",
      productName: "database",
    }),
    generatedDrizzleConfigFilesByDatabase,
    generatedSchemaFilesByDatabase,
    rootDir,
    tableContributionsByDatabase,
  }
}
