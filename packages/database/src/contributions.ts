import { collectContributions, describeContribution } from "@vite-hub/internal/contributions"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedContribution, ContributingPlugin, Contribution, ContributionContext, ContributionFactory } from "@vite-hub/internal/contributions"
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

/** Roots that ViteHub passes to contribution factories. `root` is the Vite root. */
export type DatabaseContributionContext = ContributionContext

export type DatabaseContributionFactory = ContributionFactory<DatabaseContribution>

/** A Vite plugin that contributes Database tables through `vitehub.databases`. */
export type DatabaseContributingPlugin = ContributingPlugin<"databases", DatabaseContribution>

/** A validated contribution with its export resolved and the name of the plugin that contributed it. */
export type CollectedDatabaseContribution = CollectedContribution & DatabaseContributionFields

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

/**
 * Collects `vitehub.databases` contributions from Vite plugins. Invalid entries and two
 * contributions with one name fail with `DATABASE_INVALID_CONTRIBUTION`.
 */
export async function collectDatabaseContributions(
  plugins: readonly unknown[] | undefined,
  context: DatabaseContributionContext,
): Promise<CollectedDatabaseContribution[]> {
  return await collectContributions(plugins, {
    context,
    duplicate: problem => databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem }),
    fields: readDatabaseFields,
    invalid: problem => databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem }),
    key: "databases",
    kind: "Database tables",
  })
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
