import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createGeneratedDefinitionPath,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizeSuffixDefinitionName,
  sanitizeDefinitionFilename,
} from "@vite-hub/internal/definition-catalog"
import { findIdentifierCalls, findMatching, splitTopLevel } from "@vite-hub/internal/source-scanner"

import { createRuntimeEnvConfigValue, resolveConfigValue } from "./config-value.ts"

import type {
  CloudflareD1BindingConfig,
  CloudflareD1HttpConfig,
  DatabaseConfigValue,
  DatabaseConnectionConfig,
  DBModulePublicOptions,
  DiscoveredDatabaseDefinition,
  ResolvedCloudflareD1BindingConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
} from "./types.ts"

export { resolveConfigValue } from "./config-value.ts"

const configFilePattern = /^config\.(?:c|m)?[jt]s$/i
const viteDatabaseSuffixPattern = /\.database\.(?:c|m)?[jt]s$/i

function readDefinitionObjectBody(file: string) {
  const source = readFileSync(file, "utf8")
  const calls = findIdentifierCalls(source, "defineDatabase")
  const call = calls.find(item => /(?:^|[;\n])\s*export\s+default\s*$/.test(source.slice(Math.max(0, item.start - 100), item.start)))
    || calls[0]
  const argument = call?.arguments[0]?.trim()
  if (!argument?.startsWith("{")) return
  const closeIndex = findMatching(argument, 0, "{", "}")
  return closeIndex === undefined ? undefined : argument.slice(1, closeIndex)
}

function objectLiteralBody(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed?.startsWith("{")) return
  const closeIndex = findMatching(trimmed, 0, "{", "}")
  return closeIndex === undefined ? undefined : trimmed.slice(1, closeIndex)
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*(?::|$)/.exec(entry)
  return match?.[1] || match?.[2]
}

function readEntryValue(entry: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_$][\w$]*|["'][^"']+["'])\s*:/.exec(entry)
  return match ? entry.slice(match[0].length).trim() : undefined
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

function readDatabaseTableNames(file: string) {
  return readObjectKeys(objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "tables")))
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

function readStaticStringLiteral(expression: string) {
  return /^["']([^"']*)["']$/.exec(expression)?.[1]
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

function readDefinitionCloudflareConfig(file: string): CloudflareD1BindingConfig | undefined {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "cloudflare"))
  if (!body) return
  const httpExpression = readObjectPropertyValue(body, "http")?.trim()
  const httpBody = objectLiteralBody(httpExpression)
  const http = httpExpression === "true"
    ? true
    : httpBody
      ? {
          authToken: readConfigValue(httpBody, "authToken"),
          url: readConfigValue(httpBody, "url"),
        } satisfies Partial<CloudflareD1HttpConfig>
      : undefined
  const value = {
    binding: readStringValue(body, "binding"),
    databaseId: readConfigValue(body, "databaseId"),
    databaseName: readConfigValue(body, "databaseName"),
    ...(http && (http === true || http.authToken || http.url) ? { http: http as true | CloudflareD1HttpConfig } : {}),
    migrationsTable: readStringValue(body, "migrationsTable"),
    previewDatabaseId: readConfigValue(body, "previewDatabaseId"),
  } satisfies CloudflareD1BindingConfig
  return Object.values(value).some(item => typeof item !== "undefined") ? value : undefined
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

function createDatabaseDefinition(source: string, file: string, name: string, mode: "default" | "named"): DiscoveredDatabaseDefinition {
  return {
    handler: file,
    mode,
    name,
    source,
    tableNames: readDatabaseTableNames(file),
  }
}

function discoverServerDatabases(rootDir: string, serverDirs = [resolve(rootDir, "server")]) {
  return discoverDefinitions<DiscoveredDatabaseDefinition>("database", [
    createDirectoryDefinitionSource("server-database-default", serverDirs, "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        return dirname(file).replace(/\\/g, "/") === directory.replace(/\\/g, "/") ? "default" : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("server-database-default", file, name, "default"),
    }),
    createDirectoryDefinitionSource("server-databases-named", serverDirs, "databases", {
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
  const suffixDefinitions = discoverDefinitions<DiscoveredDatabaseDefinition>("database", [
    createSuffixDefinitionSource("vite-database-suffix", [rootDir], viteDatabaseSuffixPattern, (root, file) => {
      const name = normalizeSuffixDefinitionName(root, file, viteDatabaseSuffixPattern, { stripPrefix: "src/" })
      return name === "database" ? undefined : name
    }, {
      createDefinition: ({ file, name }) => createDatabaseDefinition("vite-database-suffix", file, name, "named"),
    }),
  ])
  return [...defaultDefinitions, ...suffixDefinitions]
}

export function discoverDatabaseDefinitions(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredDatabaseDefinition[] {
  const definitions = [...discoverServerDatabases(rootDir, options.serverDirs), ...discoverViteDatabases(rootDir)]
    .filter((definition, index, all) => all.findIndex(item => item.handler === definition.handler) === index)
  const hasDefault = definitions.some(definition => definition.mode === "default")
  const hasNamed = definitions.some(definition => definition.mode === "named")
  if (hasDefault && hasNamed) {
    throw new Error("[vitehub] Database definitions must use either one default database or all named databases, not both.")
  }
  if (definitions.filter(definition => definition.mode === "default").length > 1) {
    throw new Error("[vitehub] Only one default database definition is allowed.")
  }
  return definitions.sort((left, right) => left.name.localeCompare(right.name))
}

function getDefaultCloudflareBindingName(name: string) {
  if (name === "default") return "DB"
  const suffix = name
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function getDefaultMigrationsDir(rootDir: string, definition: DiscoveredDatabaseDefinition) {
  if (definition.source === "server-database-default") {
    return relative(rootDir, resolve(rootDir, "server", "databases", "migrations"))
  }
  if (definition.source === "server-databases-named") {
    return relative(rootDir, resolve(dirname(definition.handler), "migrations"))
  }
  return relative(rootDir, resolve(dirname(definition.handler), "migrations"))
}

function normalizeCloudflareConfig(
  value: CloudflareD1BindingConfig | undefined,
  name: string,
  migrationsDir: string,
): ResolvedCloudflareD1BindingConfig | undefined {
  if (!value) return
  return {
    binding: typeof value.binding === "string" && value.binding.trim() ? value.binding.trim() : getDefaultCloudflareBindingName(name),
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
  discovery: { serverDirs?: string[] } = {},
): ResolvedDBViteConfig | undefined {
  if (options === false) return

  const definitions = discoverDatabaseDefinitions(rootDir, discovery)
  if (!definitions.length) return

  const databases: Record<string, ResolvedDrizzleDatabaseConfig> = {}
  const generatedDrizzleConfigFilesByDatabase: Record<string, string> = {}
  const generatedSchemaFilesByDatabase: Record<string, string> = {}
  for (const definition of definitions) {
    const migrationsDir = getDefaultMigrationsDir(rootDir, definition)
    const generatedSchemaFile = createGeneratedSchemaFile(rootDir, definition.name)
    generatedDrizzleConfigFilesByDatabase[definition.name] = createGeneratedDrizzleConfigFile(rootDir, definition.name)
    generatedSchemaFilesByDatabase[definition.name] = generatedSchemaFile
    databases[definition.name] = {
      cloudflare: normalizeCloudflareConfig(readDefinitionCloudflareConfig(definition.handler), definition.name, migrationsDir),
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

  return {
    databaseNames: definitions.map(definition => definition.name),
    databases,
    definitions,
    generatedDrizzleConfigFile: createGeneratedDefinitionPath(rootDir, {
      fileName: "drizzle.config.ts",
      productName: "database",
    }),
    generatedDrizzleConfigFilesByDatabase,
    generatedSchemaFilesByDatabase,
    rootDir,
  }
}
