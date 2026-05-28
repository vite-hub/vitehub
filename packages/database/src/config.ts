import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createGeneratedDefinitionPath,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizeSuffixDefinitionName,
  sanitizeDefinitionFilename,
} from "@vitehub/internal/definition-catalog"

import { createRuntimeEnvConfigValue, resolveConfigValue } from "./config-value.ts"

import type {
  CloudflareD1BindingConfig,
  DatabaseConfigValue,
  DBModulePublicOptions,
  DiscoveredDatabaseDefinition,
  ResolvedCloudflareD1BindingConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
} from "./types.ts"

const configFilePattern = /^config\.(?:c|m)?[jt]s$/i
const viteDatabaseSuffixPattern = /\.database\.(?:c|m)?[jt]s$/i

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function findMatchingBrace(source: string, openIndex: number) {
  let depth = 0
  let quote: "\"" | "'" | "`" | undefined
  let escaped = false
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") depth++
    if (char === "}") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function extractObjectBody(source: string, property: string) {
  const match = new RegExp(`\\b${property}\\s*:`).exec(source)
  if (!match) return
  const openIndex = source.indexOf("{", match.index + match[0].length)
  if (openIndex === -1) return
  const closeIndex = findMatchingBrace(source, openIndex)
  if (closeIndex === -1) return
  return source.slice(openIndex + 1, closeIndex)
}

function extractTopLevelObjectKeys(body: string) {
  const keys: string[] = []
  let depth = 0
  let quote: "\"" | "'" | "`" | undefined
  let escaped = false
  let segmentStart = 0

  const readKey = (segment: string) => {
    const trimmed = segment.trim()
    const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed)
      || /^["']([^"']+)["']\s*:/.exec(trimmed)
      || /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(trimmed)
    if (match?.[1]) keys.push(match[1])
  }

  for (let index = 0; index <= body.length; index++) {
    const char = body[index]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{" || char === "(" || char === "[") depth++
    if (char === "}" || char === ")" || char === "]") depth--
    if ((char === "," && depth === 0) || index === body.length) {
      readKey(body.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }

  return [...new Set(keys)]
}

function readDatabaseTableNames(file: string) {
  const source = stripComments(readFileSync(file, "utf8"))
  const tablesBody = extractObjectBody(source, "tables")
  if (!tablesBody) return []
  return extractTopLevelObjectKeys(tablesBody)
}

function readConfigValue(body: string | undefined, property: string): DatabaseConfigValue | undefined {
  if (!body) return
  const match = new RegExp(`\\b${property}\\s*:\\s*([^,\\n]+(?:\\|\\|\\s*[^,\\n]+)?)`).exec(body)
  const expression = match?.[1]?.trim()
  if (!expression) return
  const quoted = readStaticStringLiteral(expression)
  if (typeof quoted !== "undefined") return quoted
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
  const source = stripComments(readFileSync(file, "utf8"))
  const body = extractObjectBody(source, "cloudflare")
  if (!body) return
  const value = {
    binding: readStringValue(body, "binding"),
    databaseId: readConfigValue(body, "databaseId"),
    databaseName: readConfigValue(body, "databaseName"),
    migrationsTable: readStringValue(body, "migrationsTable"),
    previewDatabaseId: readConfigValue(body, "previewDatabaseId"),
  } satisfies CloudflareD1BindingConfig
  return Object.values(value).some(item => typeof item !== "undefined") ? value : undefined
}

function readDefinitionConnectionConfig(file: string) {
  const source = stripComments(readFileSync(file, "utf8"))
  const body = extractObjectBody(source, "connection")
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

function discoverNitroDatabases(rootDir: string) {
  const serverDir = resolve(rootDir, "server")
  return discoverDefinitions<DiscoveredDatabaseDefinition>("database", [
    createDirectoryDefinitionSource("nitro-server-database-default", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        return dirname(file).replace(/\\/g, "/") === directory.replace(/\\/g, "/") ? "default" : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("nitro-server-database-default", file, name, "default"),
    }),
    createDirectoryDefinitionSource("nitro-server-databases-named", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        const name = relative(directory, dirname(file)).replace(/\\/g, "/")
        return name && name !== "." ? name : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("nitro-server-databases-named", file, name, "named"),
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

export function discoverDatabaseDefinitions(rootDir: string): DiscoveredDatabaseDefinition[] {
  const definitions = [...discoverNitroDatabases(rootDir), ...discoverViteDatabases(rootDir)]
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
  if (definition.source === "nitro-server-database-default") {
    return relative(rootDir, resolve(rootDir, "server", "databases", "migrations"))
  }
  if (definition.source === "nitro-server-databases-named") {
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
    ...(typeof value.previewDatabaseId !== "undefined" ? { previewDatabaseId: value.previewDatabaseId } : {}),
    ...(typeof value.databaseName !== "undefined" ? { databaseName: value.databaseName } : {}),
    migrationsDir,
    ...(typeof value.migrationsTable === "string" && value.migrationsTable.trim() ? { migrationsTable: value.migrationsTable.trim() } : {}),
  }
}

function getDefaultConnection(name: string) {
  return {
    authToken: undefined,
    url: name === "default" ? "file:.data/database/sqlite.db" : `file:.data/database/${name}.sqlite.db`,
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

export function resolveDBViteConfig(options?: DBModulePublicOptions, rootDir = process.cwd()): ResolvedDBViteConfig | undefined {
  if (options === false) return

  const definitions = discoverDatabaseDefinitions(rootDir)
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
      connection: readDefinitionConnectionConfig(definition.handler) ?? getDefaultConnection(definition.name),
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
