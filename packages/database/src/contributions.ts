import { isAbsolute } from "pathe"

import { collectContributions, describeContribution, flattenPluginOptions } from "@vite-hub/internal/contributions"
import { isPlainObject } from "@vite-hub/internal/object"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedContribution, Contribution, ContributionContext } from "@vite-hub/internal/contributions"
import type { DatabaseDialect } from "./types.ts"

const databaseDialects: readonly DatabaseDialect[] = ["sqlite", "postgresql"]

/** Fields shared by Database table contributions and uses. */
export interface DatabaseContributionFields {
  /** Database Definition that receives the tables. Omit it to target the default or only Database. */
  database?: string
  /** SQL dialect of the tables. When set, the target Database must use this dialect. */
  dialect?: DatabaseDialect
}

interface DatabaseTableContributionFields extends DatabaseContributionFields {
  /**
   * Every table of `definition.export`: its schema key and its SQL name. With it, the Database lists the tables
   * without loading the module, so resolving the Vite config loads neither the schema nor drizzle-orm. The generated
   * schema still imports the module. A key that is missing here is missing from the generated schema.
   */
  tables?: Readonly<Record<string, string>>
}

/**
 * Drizzle tables that another package adds to a Database Definition from its Vite plugin. The Database plugin merges
 * them into the generated Drizzle schema, so `vitehub db generate` writes their migrations and
 * `useDatabase(name).schema` holds them, without the application editing its Definition. `name` names the group of
 * tables, and `definition.export` names an export that holds an object of Drizzle tables.
 */
export type DatabaseContribution = Contribution & DatabaseTableContributionFields

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

/**
 * A package that stores data in a Database without Drizzle tables, for example because it runs its own SQL. It has
 * no `definition`. Like tables, it targets `database`, or the default or only Database, and gets the implicit
 * default Database when the app has no Database Definition. `vitehub inspect` shows its `reason`.
 */
export interface DatabaseUseContribution extends DatabaseContributionFields {
  /** Name of the data, for example the feature that stores it. */
  name: string
  definition?: never
  /** Why the package uses the Database. `vitehub inspect` shows it. */
  reason?: string
}

/** One entry of `vitehub.databases`: tables for a Database, data without tables, or a whole Database Definition. */
export type DatabaseContributionEntry = DatabaseContribution | DatabaseUseContribution | DatabaseDefinitionContribution

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
export type CollectedDatabaseContribution = CollectedContribution & DatabaseTableContributionFields

/** A validated use without tables, with the name of the plugin that contributed it. */
export interface CollectedDatabaseUse extends DatabaseUseContribution {
  plugin: string
}

/** Everything that Vite plugins contribute to the Database primitive. */
export interface CollectedDatabaseContributions {
  /** Database Definitions, sorted by name. */
  definitions: CollectedDatabaseDefinitionContribution[]
  /** Tables for Databases that the application or a contributed Definition defines, sorted by name. */
  tables: CollectedDatabaseContribution[]
  /** Data without tables, sorted by name. */
  uses: CollectedDatabaseUse[]
}

/** A contribution whose target Database is resolved. */
export interface ResolvedDatabaseContribution extends CollectedDatabaseContribution {
  database: string
}

/** A use whose target Database is resolved. */
export interface ResolvedDatabaseUse extends CollectedDatabaseUse {
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

function readDatabaseFields(entry: Readonly<Record<string, unknown>>, fail: (reason: string) => never): DatabaseTableContributionFields {
  const { database, dialect, tables } = entry
  const fields: DatabaseTableContributionFields = {}
  if (tables !== undefined) {
    if (!isPlainObject(tables) || !Object.keys(tables).length || Object.values(tables).some(name => String(name) !== name || !name)) {
      fail(`\`tables\` of ${JSON.stringify(entry.name)} must map each schema key to its SQL table name.`)
    }
    // SAFETY: the check above makes every value a non-empty string.
    fields.tables = { ...tables as Record<string, string> }
  }
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

/** Describes a contribution as `"name" (module#export from plugin "plugin")` for errors and inspection. */
export function describeDatabaseContribution(contribution: CollectedDatabaseContribution | CollectedDatabaseUse): string {
  const { definition, plugin } = contribution
  return `${JSON.stringify(contribution.name)} (${definition ? describeContribution({ definition, plugin }) : `from plugin ${JSON.stringify(plugin)}`})`
}

function describeTarget(contribution: CollectedDatabaseContribution | CollectedDatabaseUse): string {
  return `${contribution.definition ? "Tables" : "Data"} ${describeDatabaseContribution(contribution)}`
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

const useKeys: ReadonlySet<string> = new Set(["database", "dialect", "name", "reason"])

// An entry with only these keys is a use. Any other key, such as a misplaced `module`, makes it a table entry, so the
// table reader reports the missing `definition`.
function isUseEntry(entry: unknown): entry is Record<string, unknown> {
  return isPlainObject(entry) && Object.keys(entry).every(key => useKeys.has(key))
}

function readUseContribution(entry: Record<string, unknown>, plugin: string): CollectedDatabaseUse {
  const fail = (reason: string): never => {
    throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] Plugin ${JSON.stringify(plugin)} contributed an invalid Database use: ${reason}` })
  }
  const { name, reason } = entry
  if (String(name) !== name || !name.trim()) return fail("`name` must be a non-empty string.")
  if (reason !== undefined && (String(reason) !== reason || !reason)) return fail(`\`reason\` of ${JSON.stringify(name)} must be a non-empty string.`)
  return { name, plugin, ...(reason === undefined ? {} : { reason }), ...readDatabaseFields(entry, fail) }
}

function describeDefinitionContribution(contribution: CollectedDatabaseDefinitionContribution): string {
  return `${contribution.definition} (contributed by plugin ${JSON.stringify(contribution.plugin)})`
}

/**
 * Collects `vitehub.databases` contributions from Vite plugins. An entry whose `definition` is a path string adds a
 * Database Definition; an entry with `definition: { module, export? }` adds tables; an entry without `definition`
 * uses a Database without tables. Invalid entries and two table contributions or uses with one name fail with
 * `DATABASE_INVALID_CONTRIBUTION`. Two different Database Definitions with one name fail with
 * `DATABASE_DUPLICATE_DEFINITION`. One plugin that is registered twice adds its entries once.
 */
export async function collectDatabaseContributions(
  plugins: readonly unknown[] | undefined,
  context: DatabaseContributionContext,
): Promise<CollectedDatabaseContributions> {
  const candidates = await flattenPluginOptions(plugins)
  // Factories see the flat plugin list, so they can read sibling plugins without unwrapping Vite plugin options.
  const factoryContext: DatabaseContributionContext = { ...context, plugins: candidates }
  const definitions = new Map<string, CollectedDatabaseDefinitionContribution>()
  const uses = new Map<string, CollectedDatabaseUse>()
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
      if (isUseEntry(entry)) {
        const use = readUseContribution(entry, plugin)
        const existing = uses.get(use.name)
        if (existing) {
          throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] Plugins ${JSON.stringify(existing.plugin)} and ${JSON.stringify(use.plugin)} both contributed the Database use ${JSON.stringify(use.name)}.` })
        }
        uses.set(use.name, use)
        continue
      }
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
  for (const table of tables) {
    const use = uses.get(table.name)
    if (use) {
      throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] Database contribution ${JSON.stringify(table.name)} is contributed more than once: ${describeTarget(table)} and ${describeTarget(use)}.` })
    }
  }
  return {
    definitions: [...definitions.values()].sort(byName),
    tables,
    uses: [...uses.values()].sort(byName),
  }
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** Whether a contribution goes to the default Database when the app has no Database Definition. */
function targetsDefaultDatabase(contribution: DatabaseContributionFields): boolean {
  return contribution.database === undefined || contribution.database === "default"
}

/**
 * Contributions that need the implicit default Database, which the app gets when it has no Database Definition: the
 * tables and uses without `database` or with `database: "default"`.
 */
export function implicitDefaultDatabaseContributions(contributions: Partial<CollectedDatabaseContributions> = {}): (CollectedDatabaseContribution | CollectedDatabaseUse)[] {
  return [...contributions.tables ?? [], ...contributions.uses ?? []].filter(targetsDefaultDatabase)
}

/**
 * The dialect of the implicit default Database: the `dialect` that the contributions for it set, else `sqlite`. Two
 * different dialects fail with `DATABASE_INVALID_CONTRIBUTION_TARGET`, because one Database cannot use both.
 */
export function resolveImplicitDefaultDialect(contributions: Partial<CollectedDatabaseContributions> = {}): DatabaseDialect {
  const needs = implicitDefaultDatabaseContributions(contributions).filter(contribution => contribution.dialect)
  const dialects = [...new Set(needs.map(contribution => contribution.dialect))]
  if (dialects.length > 1) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({
      reason: "dialects",
      source: needs.map(contribution => `${describeTarget(contribution)} use "${contribution.dialect}"`).join("; "),
    })
  }
  return dialects[0] ?? "sqlite"
}

/**
 * Assigns each table contribution or use to a Database Definition. One without `database` targets the default or only
 * Database. A missing, ambiguous, or absent target, or a target with another dialect, fails with
 * `DATABASE_INVALID_CONTRIBUTION_TARGET` and names the choices.
 */
export function resolveDatabaseContributionTargets<T extends CollectedDatabaseContribution | CollectedDatabaseUse>(
  databaseNames: readonly string[],
  contributions: readonly T[],
  dialects: Readonly<Record<string, DatabaseDialect>> = {},
): Record<string, (T & { database: string })[]> {
  const byDatabase: Record<string, (T & { database: string })[]> = Object.create(null)
  const choices = [...databaseNames].sort()
  for (const contribution of contributions) {
    const source = describeTarget(contribution)
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
