import { isAbsolute } from "pathe"

import { collectContributions, describeContribution, flattenPluginOptions } from "@vite-hub/internal/contributions"
import { isPlainObject } from "@vite-hub/internal/object"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedContribution, Contribution, ContributionContext } from "@vite-hub/internal/contributions"
import type { DatabaseDialect } from "./types.ts"

const databaseDialects: readonly DatabaseDialect[] = ["sqlite", "postgresql"]

/** Fields that only Database contributions have. */
export interface DatabaseContributionFields {
  /** Database Definition that receives the tables. Omit it to target the default or only Database. */
  database?: string
  /** SQL dialect of the tables. When set, the target Database must use this dialect. */
  dialect?: DatabaseDialect
}

/**
 * Drizzle tables that another package adds to a Database Definition from its Vite plugin. The Database plugin merges
 * them into the generated Drizzle schema, so `vitehub db generate` writes their migrations and
 * `useDatabase(name).schema` holds them, without the application editing its Definition. `name` names the group of
 * tables, and `definition.export` names an export that holds an object of Drizzle tables.
 */
export type DatabaseContribution = Contribution & DatabaseContributionFields

/**
 * A Database Definition that another package adds from its Vite plugin, for example because the application has no
 * Database the package can use. It behaves like a discovered Definition: `vitehub db generate`, the runtime,
 * provisioning, and inspection see it. Its migrations go where an application Definition with the same name keeps
 * them, so adding that Definition later continues the same history.
 */
export interface DatabaseDefinitionContribution {
  /** Database name. The application must not define a Database with this name. */
  name: string
  /** Absolute path of a module whose default export is `defineDatabase({ schema })`. */
  definition: string
  /** Why the package adds the Database. `vitehub inspect` shows it. */
  reason?: string
}

/** One entry of `vitehub.databases`: tables for a Database, or a whole Database Definition. */
export type DatabaseContributionEntry = DatabaseContribution | DatabaseDefinitionContribution

/**
 * Roots that ViteHub passes to contribution factories. `root` is the Vite root, `rootDir` is the root that Database
 * Definitions are discovered from, and `plugins` lets a factory inspect the contributions of other plugins.
 */
export interface DatabaseContributionContext extends ContributionContext {
  rootDir: string
  plugins?: readonly unknown[]
}

/**
 * Returns the contributions of a plugin. It runs once per discovery pass, so it must be idempotent and must not depend
 * on the order of Vite config hooks.
 */
export type DatabaseContributionFactory = (context: DatabaseContributionContext) =>
  | readonly DatabaseContributionEntry[]
  | undefined
  | Promise<readonly DatabaseContributionEntry[] | undefined>

/** A Vite plugin that contributes Database tables or Database Definitions through `vitehub.databases`. */
export interface DatabaseContributingPlugin {
  name?: string
  vitehub?: { databases?: readonly DatabaseContributionEntry[] | DatabaseContributionFactory }
}

/** A validated Database Definition contribution with the name of the plugin that contributed it. */
export interface CollectedDatabaseDefinitionContribution extends DatabaseDefinitionContribution {
  plugin: string
}

/** A validated contribution with its export resolved and the name of the plugin that contributed it. */
export type CollectedDatabaseContribution = CollectedContribution & DatabaseContributionFields

/** Everything that Vite plugins contribute to the Database primitive. */
export interface CollectedDatabaseContributions {
  /** Database Definitions, sorted by name. */
  definitions: CollectedDatabaseDefinitionContribution[]
  /** Tables for Databases that the application or a contributed Definition defines, sorted by name. */
  tables: CollectedDatabaseContribution[]
}

/** A contribution whose target Database is resolved. */
export interface ResolvedDatabaseContribution extends CollectedDatabaseContribution {
  database: string
}

/** How `resolveDefaultDatabase()` picked a Database, or why it could not. */
export type DefaultDatabaseResolution =
  | { status: "resolved", name: string, reason: "default" | "only" }
  | { status: "ambiguous", names: string[] }
  | { status: "none" }

/**
 * Resolves "the default or only Database": the Definition named `default`, else the only Definition. Several
 * Definitions without a `default` are ambiguous; no Definitions resolve to `none`.
 */
export function resolveDefaultDatabase(databaseNames: readonly string[]): DefaultDatabaseResolution {
  if (databaseNames.includes("default")) return { name: "default", reason: "default", status: "resolved" }
  if (databaseNames.length === 1) return { name: databaseNames[0]!, reason: "only", status: "resolved" }
  if (databaseNames.length) return { names: [...databaseNames].sort(), status: "ambiguous" }
  return { status: "none" }
}

function isDatabaseDialect(value: unknown): value is DatabaseDialect {
  return databaseDialects.some(dialect => dialect === value)
}

function readDatabaseFields(entry: Readonly<Record<string, unknown>>, fail: (reason: string) => never): DatabaseContributionFields {
  const { database, dialect } = entry
  const fields: DatabaseContributionFields = {}
  if (database !== undefined) {
    if (String(database) !== database || !database || database.trim() !== database) {
      fail(`\`database\` of ${JSON.stringify(entry.name)} must be a Database name without surrounding whitespace. Omit it to target the default or only Database.`)
    }
    fields.database = String(database)
  }
  if (dialect !== undefined) {
    if (!isDatabaseDialect(dialect)) fail(`\`dialect\` of ${JSON.stringify(entry.name)} must be one of ${databaseDialects.map(name => JSON.stringify(name)).join(", ")}.`)
    fields.dialect = dialect
  }
  return fields
}

/** Describes a contribution as `module#export from plugin "name"` for errors and inspection. */
export function describeDatabaseContribution(contribution: CollectedDatabaseContribution): string {
  return `${JSON.stringify(contribution.name)} (${describeContribution(contribution)})`
}

const definitionNamePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

function readDefinitionContribution(entry: Record<string, unknown>, plugin: string): CollectedDatabaseDefinitionContribution {
  const fail = (reason: string) => databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] Plugin ${JSON.stringify(plugin)} contributed an invalid Database Definition: ${reason}` })
  const { definition, name, reason } = entry
  if (String(name) !== name || !definitionNamePattern.test(name)) {
    throw fail("`name` must be a Database name of letters, numbers, dots, underscores, dashes, and slashes.")
  }
  if (String(definition) !== definition || !definition || !isAbsolute(definition)) {
    throw fail(`Database ${JSON.stringify(name)} needs \`definition\`, the absolute path of its Definition module.`)
  }
  if (reason !== undefined && (String(reason) !== reason || !reason)) throw fail(`\`reason\` of Database ${JSON.stringify(name)} must be a non-empty string.`)
  if (Object.hasOwn(entry, "database") || Object.hasOwn(entry, "dialect")) {
    throw fail(`Database ${JSON.stringify(name)} mixes a Definition contribution { name, definition, reason? } with the \`database\` or \`dialect\` of a table contribution. Contribute them as two entries.`)
  }
  return { definition, name, plugin, ...(reason === undefined ? {} : { reason }) }
}

function describeDefinitionContribution(contribution: CollectedDatabaseDefinitionContribution): string {
  return `${contribution.definition} (contributed by plugin ${JSON.stringify(contribution.plugin)})`
}

/**
 * Collects `vitehub.databases` contributions from Vite plugins. An entry whose `definition` is a path string adds a
 * Database Definition; an entry with `definition: { module, export? }` adds tables. Invalid entries and two table
 * contributions with one name fail with `DATABASE_INVALID_CONTRIBUTION`. Two different Database Definitions with one
 * name fail with `DATABASE_DUPLICATE_DEFINITION`. One plugin that is registered twice adds its entries once.
 */
export async function collectDatabaseContributions(
  plugins: readonly unknown[] | undefined,
  context: DatabaseContributionContext,
): Promise<CollectedDatabaseContributions> {
  const candidates = await flattenPluginOptions(plugins)
  // Factories see the flat plugin list, so they can read sibling plugins without unwrapping Vite plugin options.
  const factoryContext: DatabaseContributionContext = { ...context, plugins: candidates }
  const definitions = new Map<string, CollectedDatabaseDefinitionContribution>()
  const tablePlugins: object[] = []
  for (const candidate of candidates) {
    if (!Object.hasOwn(candidate, "vitehub")) continue
    const metadata: unknown = Reflect.get(candidate, "vitehub")
    if (!isPlainObject(metadata) || !Object.hasOwn(metadata, "databases")) continue
    const source = metadata.databases
    const pluginName: unknown = Reflect.get(candidate, "name")
    const plugin = String(pluginName) === pluginName && pluginName ? pluginName : "unnamed plugin"
    // Run each factory once, then route Definition entries here and table entries to the shared collector.
    const callable = typeof source === "function"
    const entries: unknown = callable ? await Reflect.apply(source, undefined, [factoryContext]) : source
    if (entries === undefined && callable) continue
    if (!Array.isArray(entries)) {
      tablePlugins.push({ name: plugin, vitehub: { databases: entries } })
      continue
    }
    const tables: unknown[] = []
    for (const entry of entries as readonly unknown[]) {
      if (!isPlainObject(entry) || String(entry.definition) !== entry.definition) {
        tables.push(entry)
        continue
      }
      const contribution = readDefinitionContribution(entry, plugin)
      const existing = definitions.get(contribution.name)
      if (existing && existing.definition !== contribution.definition) {
        throw databaseErrorDiagnostics.DATABASE_DUPLICATE_DEFINITION({ database: contribution.name, files: [describeDefinitionContribution(existing), describeDefinitionContribution(contribution)] })
      }
      if (!existing) definitions.set(contribution.name, contribution)
    }
    tablePlugins.push({ name: plugin, vitehub: { databases: tables } })
  }
  const tables = await collectContributions(tablePlugins, {
    context: factoryContext,
    duplicate: problem => databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem }),
    fields: readDatabaseFields,
    invalid: problem => databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem }),
    key: "databases",
    kind: "Database tables",
  })
  return {
    definitions: [...definitions.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    tables,
  }
}

/**
 * Assigns each contribution to a Database Definition. A contribution without `database` targets the default or only
 * Database. A missing, ambiguous, or absent target, or a target with another dialect, fails with
 * `DATABASE_INVALID_CONTRIBUTION_TARGET` and names the choices.
 */
export function resolveDatabaseContributionTargets(
  databaseNames: readonly string[],
  contributions: readonly CollectedDatabaseContribution[],
  dialects: Readonly<Record<string, DatabaseDialect>> = {},
): Record<string, ResolvedDatabaseContribution[]> {
  const byDatabase: Record<string, ResolvedDatabaseContribution[]> = Object.create(null)
  const choices = [...databaseNames].sort()
  for (const contribution of contributions) {
    const source = `Tables ${describeDatabaseContribution(contribution)}`
    let database = contribution.database
    if (database === undefined) {
      const resolution = resolveDefaultDatabase(databaseNames)
      if (resolution.status === "none") {
        throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({ reason: "none", source })
      }
      if (resolution.status === "ambiguous") {
        throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({ choices, reason: "ambiguous", source })
      }
      database = resolution.name
    }
    else if (!databaseNames.includes(database)) {
      throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({ choices, database, reason: "missing", source })
    }
    const targetDialect = dialects[database]
    if (contribution.dialect && targetDialect && contribution.dialect !== targetDialect) {
      throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({ database, dialect: contribution.dialect, reason: "dialect", source, targetDialect })
    }
    ;(byDatabase[database] ??= []).push({ ...contribution, database })
  }
  return byDatabase
}
