import { isAbsolute } from "pathe"

import { isPlainObject } from "@vite-hub/internal/object"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * Drizzle tables that another package adds to a Database Definition from its Vite plugin. The Database plugin merges
 * them into the generated Drizzle schema, so `vitehub db generate` writes their migrations and
 * `useDatabase(name).schema` holds them, without the application editing its Definition.
 */
export interface DatabaseContribution {
  /** Database Definition that receives the tables. Omit it to target the default or only Database. */
  database?: string
  /**
   * Module that exports the tables: an absolute file path, or a package specifier that the application can import.
   * Relative paths are rejected because they have no stable base.
   */
  module: string
  /** Named export that holds an object of Drizzle tables. Defaults to `default`. */
  export?: string
  /** Dialect used by the contributed tables. Defaults to sqlite. */
  dialect?: "sqlite" | "postgresql"
}

/**
 * A Database Definition that another package adds from its Vite plugin, for example because the application has no
 * Database the package can use. It behaves like a discovered Definition: `vitehub db generate`, the runtime,
 * provisioning, and inspection see it. Its migrations go where an application Definition with the same name keeps
 * them, so adding that Definition later continues the same history.
 */
export interface DatabaseDefinitionContribution {
  /** Database name. The application must not define a Database with this name. */
  name: string
  /** Absolute path of a module whose default export is `defineDatabase({ schema })` with the same `name`. */
  definition: string
  /** Why the package adds the Database. `vitehub inspect` shows it. */
  reason?: string
}

/** One entry of `vitehub.databases`: tables for an existing Database, or a whole Database Definition. */
export type DatabaseContributionEntry = DatabaseContribution | DatabaseDefinitionContribution

/** Discovery roots that the Database plugin passes to contribution factories. */
export interface DatabaseContributionContext {
  /** Root that Database Definitions are discovered from, after `database.projectRoot`. */
  rootDir: string
  /** Project root for host integrations. */
  projectRoot?: string
  /** Server directories that Database Definitions are discovered from, for example Nuxt's `serverDir`. */
  serverDirs?: string[]
  /** Plugins available when a contribution factory needs to inspect siblings. */
  plugins?: readonly unknown[]
}

export type DatabaseContributionFactory = (context: DatabaseContributionContext) =>
  | readonly DatabaseContributionEntry[]
  | undefined
  | Promise<readonly DatabaseContributionEntry[] | undefined>

/** Vite plugin metadata that contributes Database tables. */
export interface DatabaseContributionPluginMetadata {
  /**
   * Tables or Database Definitions to add. A factory runs once per discovery pass, so it must be idempotent and must
   * not depend on the order of Vite config hooks.
   */
  databases?: readonly DatabaseContributionEntry[] | DatabaseContributionFactory
}

export interface DatabaseContributingPlugin {
  name?: string
  vitehub?: DatabaseContributionPluginMetadata
}

/** A validated contribution with the name of the plugin that contributed it. */
export interface CollectedDatabaseContribution extends DatabaseContribution {
  contributor: string
}

/** A validated Database Definition contribution with the name of the plugin that contributed it. */
export interface CollectedDatabaseDefinitionContribution extends DatabaseDefinitionContribution {
  contributor: string
}

/** Everything that Vite plugins contribute to the Database primitive. */
export interface CollectedDatabaseContributions {
  /** Database Definitions, by contribution order. */
  definitions: CollectedDatabaseDefinitionContribution[]
  /** Tables for Databases that the application or a contributed Definition defines. */
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

function flattenPluginOptions(value: unknown, plugins: object[], seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenPluginOptions(item, plugins, seen)
    return
  }
  // Vite resolves promised plugin options before `configResolved`; unresolved promises cannot contribute.
  if (!isPlainObject(value) || seen.has(value) || typeof Reflect.get(value, "then") === "function") return
  seen.add(value)
  plugins.push(value)
}

function isNonEmptyString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Plugin metadata is opaque input; this guard classifies it without coercion.
  return typeof value === "string" && value.length > 0
}

function invalidContribution(contributor: string, reason: string): Error {
  return databaseErrorDiagnostics.DATABASE_B0012({ message: `[vitehub] Plugin "${contributor}" contributed invalid Database tables: ${reason}` })
}

function validateDefinitionContribution(value: Record<string, unknown>, contributor: string): CollectedDatabaseDefinitionContribution {
  const { definition, name, reason } = value
  if (!isNonEmptyString(name) || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(name)) {
    throw invalidContribution(contributor, "a contributed Database Definition needs a `name` of letters, numbers, dots, underscores, dashes, and slashes.")
  }
  if (!isNonEmptyString(definition) || !isAbsolute(definition)) {
    throw invalidContribution(contributor, `Database ${JSON.stringify(name)} needs \`definition\`, the absolute path of its Definition module.`)
  }
  if (reason !== undefined && !isNonEmptyString(reason)) throw invalidContribution(contributor, `\`reason\` of Database ${JSON.stringify(name)} must be a non-empty string.`)
  if (Object.hasOwn(value, "module") || Object.hasOwn(value, "database") || Object.hasOwn(value, "export")) {
    throw invalidContribution(contributor, `Database ${JSON.stringify(name)} mixes a Definition contribution { name, definition, reason? } with a table contribution { database?, module, export? }. Contribute them as two entries.`)
  }
  const contribution: CollectedDatabaseDefinitionContribution = { contributor, definition, name }
  if (reason !== undefined) contribution.reason = reason
  return contribution
}

function validateContribution(value: unknown, contributor: string): CollectedDatabaseContribution {
  if (!isPlainObject(value)) throw invalidContribution(contributor, "expected { database?, module, export? }.")
  const { database, export: exportName, module, dialect } = value
  if (!isNonEmptyString(module)) throw invalidContribution(contributor, "`module` must be a non-empty string.")
  if (!isAbsolute(module) && /^\.\.?(?:[\\/]|$)/.test(module)) {
    throw invalidContribution(contributor, `module ${JSON.stringify(module)} is relative. Use an absolute file path or a package specifier.`)
  }
  if (exportName !== undefined && !isNonEmptyString(exportName)) throw invalidContribution(contributor, `\`export\` of ${JSON.stringify(module)} must be a non-empty string.`)
  if (database !== undefined && (!isNonEmptyString(database) || database.trim() !== database)) {
    throw invalidContribution(contributor, `\`database\` of ${JSON.stringify(module)} must be a Database name without surrounding whitespace. Omit it to target the default or only Database.`)
  }
  if (dialect !== undefined && dialect !== "sqlite" && dialect !== "postgresql") {
    throw invalidContribution(contributor, "`dialect` must be one of \"sqlite\", \"postgresql\".")
  }
  const contribution: CollectedDatabaseContribution = { contributor, module }
  if (database !== undefined) contribution.database = database
  if (exportName !== undefined && exportName !== "default") contribution.export = exportName
  if (dialect !== undefined) contribution.dialect = dialect
  return contribution
}

function sameContribution(left: DatabaseContribution, right: DatabaseContribution): boolean {
  return left.database === right.database
    && left.module === right.module
    && (left.export ?? "default") === (right.export ?? "default")
    && (left.dialect ?? "sqlite") === (right.dialect ?? "sqlite")
}

/** Describes a contribution as `module#export (contributed by "plugin")` for errors and inspection. */
export function describeDatabaseContribution(contribution: DatabaseContribution & { contributor?: string }): string {
  const target = contribution.export ? `${contribution.module}#${contribution.export}` : contribution.module
  return contribution.contributor ? `${target} (contributed by "${contribution.contributor}")` : target
}

/**
 * Collects `vitehub.databases` contributions from Vite plugins. The same contribution from two plugin instances is
 * kept once. Two plugins that contribute different Definitions with one name fail with `DATABASE_B0013`.
 */
export async function collectDatabaseContributions(
  plugins: readonly unknown[] | undefined,
  context: DatabaseContributionContext,
): Promise<CollectedDatabaseContributions> {
  const candidates: object[] = []
  flattenPluginOptions(plugins ?? [], candidates, new Set())
  const contributions: CollectedDatabaseContribution[] = []
  const definitions: CollectedDatabaseDefinitionContribution[] = []
  for (const plugin of candidates) {
    if (!Object.hasOwn(plugin, "vitehub")) continue
    const metadata: unknown = Reflect.get(plugin, "vitehub")
    const value: unknown = isPlainObject(metadata) ? metadata.databases : undefined
    if (!value) continue
    const pluginName: unknown = Reflect.get(plugin, "name")
    const contributor = isNonEmptyString(pluginName) ? pluginName : "unnamed plugin"
    const entries: unknown = typeof value === "function" ? await Reflect.apply(value, undefined, [context]) : value
    if (!entries) continue
    if (!Array.isArray(entries)) throw invalidContribution(contributor, "`vitehub.databases` must be an array or return one.")
    for (const entry of entries) {
      if (isPlainObject(entry) && Object.hasOwn(entry, "definition")) {
        const definition = validateDefinitionContribution(entry, contributor)
        const existing = definitions.find(candidate => candidate.name === definition.name)
        if (!existing) definitions.push(definition)
        else if (existing.definition !== definition.definition) {
          throw databaseErrorDiagnostics.DATABASE_B0013({ message: `[vitehub] Database "${definition.name}" is contributed more than once:\n  - ${existing.definition} (contributed by "${existing.contributor}")\n  - ${definition.definition} (contributed by "${contributor}")\nEach Database name must have one Definition.` })
        }
        continue
      }
      const contribution = validateContribution(entry, contributor)
      if (!contributions.some(existing => sameContribution(existing, contribution))) contributions.push(contribution)
    }
  }
  return { definitions, tables: contributions }
}

/**
 * Assigns each contribution to a Database Definition. A contribution without `database` targets the default or only
 * Database. A missing, ambiguous, or absent target fails with `DATABASE_B0011` and names the choices.
 */
export function resolveDatabaseContributionTargets(
  databaseNames: readonly string[],
  contributions: readonly CollectedDatabaseContribution[],
  dialects?: Record<string, string>,
): Record<string, ResolvedDatabaseContribution[]> {
  const byDatabase: Record<string, ResolvedDatabaseContribution[]> = Object.create(null)
  const choices = databaseNames.length ? [...databaseNames].sort().map(name => JSON.stringify(name)).join(", ") : "none"
  for (const contribution of contributions) {
    const source = describeDatabaseContribution(contribution)
    let database = contribution.database
    if (database === undefined) {
      const resolution = resolveDefaultDatabase(databaseNames)
      if (resolution.status === "none") {
        throw databaseErrorDiagnostics.DATABASE_B0011({ message: `[vitehub] Tables from ${source} need a Database, but the app has no Database Definition. Add \`server/databases/config.ts\` with \`defineDatabase({ schema: {} })\`.` })
      }
      if (resolution.status === "ambiguous") {
        throw databaseErrorDiagnostics.DATABASE_B0011({ message: `[vitehub] Tables from ${source} target the default or only Database, but the app has several Database Definitions and none is named "default": ${choices}. Choose one with the contribution's \`database\` option.` })
      }
      database = resolution.name
    }
    else if (!databaseNames.includes(database)) {
      throw databaseErrorDiagnostics.DATABASE_B0011({ message: `[vitehub] Tables from ${source} target Database ${JSON.stringify(database)}, which has no Database Definition. Database Definitions: ${choices}.` })
    }
    const targetDialect = dialects?.[database]
    const contributionDialect = contribution.dialect ?? "sqlite"
    if (targetDialect && contributionDialect !== targetDialect) {
      throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION_TARGET({
        source,
        database,
        dialect: contributionDialect,
        targetDialect,
        reason: "dialect",
      })
    }
    ;(byDatabase[database] ??= []).push({ ...contribution, database })
  }
  return byDatabase
}
