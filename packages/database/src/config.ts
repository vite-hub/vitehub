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
import { argumentExpression, defaultExportExpression, findCalls, objectProperties, scanModule, staticString, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { computePackageDir, resolveRuntimeModule } from "@vite-hub/internal/build/paths"

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
import type { Expression, ObjectExpression } from "@vite-hub/internal/build/scan-module"

export { resolveConfigValue } from "./config-value.ts"
export { resolveDefaultDatabase, type DefaultDatabaseResolution } from "./contributions.ts"

/** Serialize generated registries without invoking the legacy __proto__ setter. */
export function serializeGeneratedRegistry(value: unknown): string {
  return JSON.stringify(value).replace(/"__proto__":/g, '["__proto__"]:')
}

const configFilePattern = /^config\.(?:c|m)?[jt]s$/i
const viteDatabaseSuffixPattern = /\.database\.(?:c|m)?[jt]s$/i

/** The options object of `defineDatabase({ ... })`. With `exact`, the object cannot have a type assertion. */
function readDefinitionObjectBody(file: string, exact = false): ObjectExpression | undefined {
  const module = scanModule(readFileSync(file, "utf8"), file)
  const exported = defaultExportExpression(module)
  const call = exported?.type === "CallExpression" && exported.callee.type === "Identifier" && exported.callee.name === "defineDatabase"
    ? exported
    : findCalls(module, ["defineDatabase"])[0]
  const argument = call?.arguments[0]
  if (argument === undefined || argument.type === "SpreadElement") return
  const object = exact ? argument : argumentExpression(argument)
  return object?.type === "ObjectExpression" ? object : undefined
}

interface ObjectEntry {
  /** Undefined for a spread, a method, an accessor, or a computed key that is not a string literal. */
  key: string | undefined
  /** The value as written, with its assertions. */
  raw: Expression | undefined
  /** The value without assertions. */
  value: Expression | undefined
}

function readObjectEntries(body: ObjectExpression | undefined): ObjectEntry[] {
  if (!body) return []
  return objectProperties(body).map((property) => {
    const node = property.node
    if (node.type === "SpreadElement" || node.kind !== "init" || node.method) return { key: undefined, raw: undefined, value: undefined }
    return { key: property.key, raw: node.value, value: property.value }
  })
}

function readObjectPropertyValue(body: ObjectExpression | undefined, property: string): Expression | undefined {
  return readObjectEntries(body).find(entry => entry.key === property)?.value
}

function readObjectKeys(body: ObjectExpression | undefined) {
  return [...new Set(readObjectEntries(body).map(entry => entry.key).filter((key): key is string => Boolean(key)))]
}

function objectLiteral(value: Expression | undefined): ObjectExpression | undefined {
  return value?.type === "ObjectExpression" ? value : undefined
}

function isUndefinedIdentifier(value: Expression | undefined): boolean {
  return value?.type === "Identifier" && value.name === "undefined"
}

export interface StaticDatabaseSchema {
  /** False when the schema has entries the source cannot show, such as an imported schema or a spread. */
  complete: boolean
  tableNames: string[]
}

/** Reads the keys of a literal `schema: { ... }` without loading the Definition. */
export function readStaticDatabaseSchema(file: string): StaticDatabaseSchema {
  const body = objectLiteral(readObjectPropertyValue(readDefinitionObjectBody(file), "schema"))
  if (body === undefined) return { complete: false, tableNames: [] }
  return {
    complete: readObjectEntries(body).every(entry => entry.key !== undefined),
    tableNames: readObjectKeys(body),
  }
}

function readConfigValue(body: ObjectExpression | undefined, property: string): DatabaseConfigValue | undefined {
  const expression = readObjectPropertyValue(body, property)
  if (!expression) return
  const quoted = readStaticStringLiteral(expression)
  if (typeof quoted !== "undefined") return quoted
  const declaration = readRuntimeEnvDeclaration(expression)
  if (declaration) return declaration
  const envName = readProcessEnvName(expression)
  if (envName) return createRuntimeEnvConfigValue([envName])
  if (expression.type !== "LogicalExpression" || (expression.operator !== "||" && expression.operator !== "??")) return
  const primary = readProcessEnvName(unwrapExpression(expression.left))
  if (!primary) return
  const fallback = unwrapExpression(expression.right)
  const fallbackEnvName = readProcessEnvName(fallback)
  if (fallbackEnvName) return createRuntimeEnvConfigValue([primary, fallbackEnvName])
  const staticFallback = readStaticStringLiteral(fallback)
  if (typeof staticFallback !== "undefined") return createRuntimeEnvConfigValue([primary], staticFallback)
}

/** Reads `env({ source: env.source("NAME" | ["NAME", ...]), default: "value" })`. */
function readRuntimeEnvDeclaration(expression: Expression): DatabaseConfigValue | undefined {
  if (expression.type !== "CallExpression" || expression.callee.type !== "Identifier" || expression.callee.name !== "env") return
  const body = objectLiteral(argumentExpression(expression.arguments[0]))
  if (!body) return
  const source = readObjectPropertyValue(body, "source")
  if (source?.type !== "CallExpression" || source.callee.type !== "MemberExpression" || source.callee.computed
    || source.callee.object.type !== "Identifier" || source.callee.object.name !== "env"
    || source.callee.property.type !== "Identifier" || source.callee.property.name !== "source") return
  const sourceValue = argumentExpression(source.arguments[0])
  const singleName = sourceValue && readStaticStringLiteral(sourceValue)
  const names = typeof singleName !== "undefined"
    ? [singleName]
    : sourceValue?.type === "ArrayExpression"
      ? sourceValue.elements.map(element => element === null || element.type === "SpreadElement" ? undefined : readStaticStringLiteral(unwrapExpression(element)))
      : undefined
  if (!names?.length || names.some(name => typeof name === "undefined" || !name.trim())) return
  const defaultValue = readObjectPropertyValue(body, "default")
  return createRuntimeEnvConfigValue(names.filter((name): name is string => name !== undefined), defaultValue && readStaticStringLiteral(defaultValue))
}

/** A quoted string literal. Template literals do not count. */
function readStaticStringLiteral(expression: Expression): string | undefined {
  return expression.type === "Literal" ? staticString(expression) : undefined
}

/** The name in `process.env.NAME` or `process.env["NAME"]`. */
function readProcessEnvName(expression: Expression): string | undefined {
  if (expression.type !== "MemberExpression" || expression.optional) return
  const env = expression.object
  if (env.type !== "MemberExpression" || env.computed || env.object.type !== "Identifier" || env.object.name !== "process"
    || env.property.type !== "Identifier" || env.property.name !== "env") return
  const name = expression.computed
    ? expression.property.type === "Literal" ? staticString(expression.property) : undefined
    : expression.property.type === "Identifier" ? expression.property.name : undefined
  return name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined
}

function readStringValue(body: ObjectExpression | undefined, property: string): string | undefined {
  const value = readConfigValue(body, property)
  const resolved = resolveConfigValue(value)
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

type DefinitionCloudflareResource = CloudflareD1Projection["resource"]

function readDefinitionCloudflareResource(expression: Expression | undefined): DefinitionCloudflareResource {
  if (isUndefinedIdentifier(expression)) return "inherited"
  const body = objectLiteral(expression)
  if (body === undefined) return "opaque"
  let resource: DefinitionCloudflareResource = "inherited"
  for (const entry of readObjectEntries(body)) {
    if (entry.key === undefined) return "opaque"
    if (entry.key !== "databaseId" && entry.key !== "databaseName") continue
    if (isUndefinedIdentifier(entry.value)) continue
    if (readConfigValue(body, entry.key) === undefined) return "opaque"
    resource = "configured"
  }
  return resource
}

function readDefinitionCloudflareConfig(file: string): { resource: DefinitionCloudflareResource, value?: CloudflareD1BindingConfig } {
  const definitionBody = readDefinitionObjectBody(file)
  const definitionEntries = readObjectEntries(definitionBody)
  const cloudflareEntries = definitionEntries.filter(entry => entry.key === "cloudflare")
  const expression = cloudflareEntries.at(-1)?.value
  let resource: DefinitionCloudflareResource = definitionBody === undefined ? "opaque" : "inherited"
  for (const entry of definitionEntries) {
    if (entry.key === undefined) {
      resource = "opaque"
    }
    else if (entry.key === "cloudflare") {
      resource = readDefinitionCloudflareResource(entry.value)
    }
  }
  const body = objectLiteral(expression)
  if (resource === "opaque") {
    if (cloudflareEntries.length && !isUndefinedIdentifier(expression)) return { resource, value: {} }
    return { resource }
  }
  if (body === undefined) return { resource }
  const httpExpression = readObjectPropertyValue(body, "http")
  const httpBody = objectLiteral(httpExpression)
  const http = httpExpression?.type === "Literal" && httpExpression.value === true
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
  const definitionEntries = readObjectEntries(definitionBody)
  if (definitionEntries.some(entry => entry.key === undefined)) return false
  const cloudflareEntries = definitionEntries.filter(entry => entry.key === "cloudflare")
  if (cloudflareEntries.length !== 1) return false
  const body = cloudflareEntries[0]!.raw
  if (body?.type !== "ObjectExpression") return false
  const entries = readObjectEntries(body)
  if (entries.some(entry => entry.key === undefined)) return false
  const httpEntries = entries.filter(entry => entry.key === "http")
  if (httpEntries.length !== 1) return false
  const http = httpEntries[0]!.raw
  return (http?.type === "Literal" && http.value === true) || http?.type === "ObjectExpression"
}

function readDefinitionConnectionConfig(file: string) {
  const body = objectLiteral(readObjectPropertyValue(readDefinitionObjectBody(file), "connection"))
  if (!body) return
  const value = {
    authToken: readConfigValue(body, "authToken"),
    url: readConfigValue(body, "url"),
  }
  return Object.values(value).some(item => typeof item !== "undefined") ? value : undefined
}

/** Reads the static `dialect` of a Database Definition. A Definition without one uses SQLite. */
export function readDatabaseDefinitionDialect(file: string): DatabaseDialect {
  const expression = readObjectPropertyValue(readDefinitionObjectBody(file), "dialect")
  if (expression === undefined) return "sqlite"
  const dialect = readStaticStringLiteral(expression)
  if (dialect === "sqlite" || dialect === "postgresql") return dialect
  throw databaseErrorDiagnostics.DATABASE_INVALID_DIALECT({ file })
}

function readDefinitionHyperdriveConfig(file: string, name: string): ResolvedCloudflareHyperdriveConfig {
  const body = objectLiteral(readObjectPropertyValue(readDefinitionObjectBody(file), "cloudflare"))
  const config: ResolvedCloudflareHyperdriveConfig = { binding: resolveCloudflareHyperdriveBindingName(name, readStringValue(body, "binding")) }
  const hyperdriveId = readConfigValue(body, "hyperdriveId")
  if (hyperdriveId !== undefined) config.hyperdriveId = hyperdriveId
  return config
}

type FoundDatabaseDefinition = Omit<DiscoveredDatabaseDefinition, "schemaSources">

function createDatabaseDefinition(source: string, file: string, name: string, mode: "default" | "named"): FoundDatabaseDefinition {
  const configuredName = readStringValue(readDefinitionObjectBody(file), "name")?.trim() || "default"
  if (configuredName !== name) {
    throw databaseErrorDiagnostics.DATABASE_NAME_MISMATCH({ file, name })
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
  for (const entry of readObjectEntries(body)) {
    if (entry.key === undefined) return
    if (!schemaOnlyDefinitionKeys.has(entry.key)) keys.add(entry.key)
  }
  return keys
}

/** Reports whether a Definition can set database options. Opaque Definitions count because ViteHub cannot read them. */
function configuresDatabase(file: string) {
  const keys = readDefinitionOptionKeys(file)
  return keys === undefined || keys.size > 0
}

function definitionFiles(definitions: Array<{ handler: string }>) {
  return definitions.map(definition => definition.handler)
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
    throw databaseErrorDiagnostics.DATABASE_DUPLICATE_DEFINITION({ database: name, files: definitionFiles(duplicates) })
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
        throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: definitionFiles([app, layer]), reason: "unreadable" })
      }
      const missing = [...layerOptions].filter(key => !appOptions.has(key))
      if (!missing.length) continue
      const options = missing.map(key => `\`${key}\``).join(", ")
      throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: definitionFiles([app, layer]), options, reason: "missing" })
    }
  }
  if (!appConfigures && configuringLayers.length > 1) {
    throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: definitionFiles(configuringLayers), reason: "layers" })
  }

  const appTables = new Set(app?.tableNames)
  const tableOwners = new Map<string, FoundDatabaseDefinition>()
  for (const definition of layers) {
    for (const tableName of definition.tableNames ?? []) {
      const owner = tableOwners.get(tableName)
      if (owner && !appTables.has(tableName)) {
        throw databaseErrorDiagnostics.DATABASE_LAYER_TABLE_CONFLICT({ database: name, files: definitionFiles([owner, definition]), table: tableName })
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

const implicitDefaultSource = "implicit-default"

/**
 * The empty default Database of an app that enables `database` without a Database Definition, for example for the
 * tables of Connections. It is `defineDatabase({ schema: {} })` from a module that this package ships.
 */
function implicitDefaultDatabase(): DiscoveredDatabaseDefinition {
  const handler = resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/default-database")
  return { handler, mode: "default", name: "default", schemaSources: [{ handler, tableNames: [] }], source: implicitDefaultSource, tableNames: [] }
}

/** Reports whether a discovered Definition is the implicit default Database, which the app does not own. */
export function isImplicitDefaultDatabase(definition: Pick<DiscoveredDatabaseDefinition, "source">): boolean {
  return definition.source === implicitDefaultSource
}

export interface DatabaseDiscoveryOptions {
  /**
   * Without a Database Definition, return the implicit default Database. The Vite plugin sets it: an enabled
   * database always has a default Database.
   */
  implicitDefault?: boolean
  serverDirs?: string[]
}

export function discoverDatabaseDefinitions(rootDir: string, options: DatabaseDiscoveryOptions = {}): DiscoveredDatabaseDefinition[] {
  const definitions = discoverAppDatabaseDefinitions(rootDir, options)
  return definitions.length || !options.implicitDefault ? definitions : [implicitDefaultDatabase()]
}

function discoverAppDatabaseDefinitions(rootDir: string, options: DatabaseDiscoveryOptions): DiscoveredDatabaseDefinition[] {
  const serverDirs = options.serverDirs ?? [resolve(rootDir, "server")]
  const found = [
    ...serverDirs.flatMap((serverDir, layer) => discoverServerDatabases(serverDir).map(definition => ({ definition, layer }))),
    ...discoverViteDatabases(rootDir).map(definition => ({ definition, layer: 0 })),
  ].filter((entry, index, all) => all.findIndex(item => item.definition.handler === entry.definition.handler) === index)
  const defaults = found.filter(entry => entry.definition.mode === "default")
  const named = found.filter(entry => entry.definition.mode === "named")
  if (defaults.length && named.length) {
    throw databaseErrorDiagnostics.DATABASE_MIXED_DEFINITIONS({ files: definitionFiles(found.map(entry => entry.definition)) })
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

/**
 * Keeps migrations in the application, also when a Nuxt layer owns the database options. The implicit default
 * Database uses the directory that `server/databases/config.ts` would use.
 */
function getDefaultMigrationsDir(rootDir: string, definition: DiscoveredDatabaseDefinition, serverDirs: string[] | undefined) {
  const [appServerDir, ...layerServerDirs] = serverDirs ?? []
  if (isImplicitDefaultDatabase(definition)) return relative(rootDir, resolve(appServerDir ?? resolve(rootDir, "server"), "databases", "migrations"))
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
    /** Without a Database Definition, resolve the implicit default Database. See `discoverDatabaseDefinitions()`. */
    implicitDefault?: boolean
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
