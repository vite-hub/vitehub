import { join } from "pathe"

import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { isWebContainer } from "@vite-hub/web-container/env"

import { collectDatabaseContributions, describeDatabaseContribution, resolveDatabaseContributionTargets } from "./contributions.ts"
import { readProvisionedId, readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { resolveConfigValue } from "./config-value.ts"
import { discoverDatabaseDefinitions, isImplicitDefaultDatabase, readDatabaseDefinitionDialect, readDatabaseDefinitionReadReplication, readStaticDatabaseSchema, resolveDBViteConfig } from "./config.ts"
import { loadContributedDatabaseSchema } from "./internal/schema-tables.ts"

import type { ViteHubDefinitionField, ViteHubDefinitionSummary, ViteHubResourceSummary } from "@vite-hub/internal/inspect"
import type { CollectedDatabaseContributions, ResolvedDatabaseContribution, ResolvedDatabaseUse } from "./contributions.ts"
import type { DatabaseConfigValue, DBModulePublicOptions } from "./types.ts"

export interface DatabaseInspectionOptions {
  /** Without a Database Definition, list the implicit default Database that an enabled database uses. */
  implicitDefault?: boolean
  /** Vite plugins that can contribute tables through `vitehub.databases`. */
  plugins?: readonly unknown[]
  projectRoot: string
  /** The integration's `readReplication`, which a Definition inherits unless it sets its own. */
  readReplication?: boolean
  /** Root that Database Definitions are discovered from. */
  rootDir: string
  serverDirs?: string[]
  /** Vite root that contribution factories receive. Defaults to `rootDir`. */
  viteRoot?: string
}

const webContainerDriver = "SQLite WASM. This WebContainer cannot load native libSQL, so a local `file:` database lives in memory and ViteHub writes the whole file after each committed write. There is no WAL and no lock with other processes."

// Inspection reads source only. Tables from an imported or spread schema are known after the Definition loads.
function describeTables(files: string[]) {
  const schemas = files.map(readStaticDatabaseSchema)
  const tableNames = [...new Set(schemas.flatMap(schema => schema.tableNames))]
  if (schemas.every(schema => schema.complete)) return tableNames.length ? tableNames.join(", ") : "None discovered"
  return tableNames.length ? `${tableNames.join(", ")}, plus an imported or spread schema` : "Imported or spread schema"
}

// A contribution module is a table module, not a Definition, so inspection loads it to name its tables.
async function describeContributedTables(contribution: ResolvedDatabaseContribution, rootDir: string): Promise<ViteHubDefinitionField> {
  const tables = await loadContributedDatabaseSchema(contribution, join(rootDir, "package.json"), { onFallback: () => {} })
    .then(schema => schema.loaded ? schema.tableNames.join(", ") || "No tables" : "Module did not load", (error: unknown) => error instanceof Error ? error.message : String(error))
  return { label: "Contributed tables", value: [`${tables} from ${describeDatabaseContribution(contribution)}`, contribution.reason].filter(Boolean).join(". ") }
}

function describeUse(use: ResolvedDatabaseUse): ViteHubDefinitionField {
  return { label: "Used by", value: [describeDatabaseContribution(use), use.reason].filter(Boolean).join(". ") }
}

// The implicit default Database exists for the contributions that need it, so name them.
function describeImplicitDefault(needs: readonly (ResolvedDatabaseContribution | ResolvedDatabaseUse)[]): string {
  const by = needs.length ? ` for ${[...new Set(needs.map(need => `plugin ${JSON.stringify(need.plugin)}`))].join(", ")}` : ""
  return `Implicit. The app has no Database Definition, so ViteHub adds an empty default Database${by}. Add \`server/databases/config.ts\` to define it yourself.`
}

/**
 * Lists Database Definitions with their mode, non-default dialect, the tables their source declares, and the tables Vite plugins
 * contribute. Definitions are read from source without loading them.
 */
export async function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const contributions = await collectDatabaseContributions(options.plugins, {
    projectRoot: options.projectRoot,
    root: options.viteRoot ?? options.rootDir,
    rootDir: options.rootDir,
    serverDirs: options.serverDirs,
  })
  const definitions = discoverDatabaseDefinitions(options.rootDir, {
    contributions,
    implicitDefault: options.implicitDefault,
    serverDirs: options.serverDirs,
  })
  const dialects = Object.fromEntries(definitions.map(definition => [definition.name, readDatabaseDefinitionDialect(definition.handler)]))
  // The build checks contribution dialects, so inspection does too.
  const contributionsByDatabase = resolveDatabaseContributionTargets(definitions.map(definition => definition.name), contributions.tables, dialects)
  const usesByDatabase = resolveDatabaseContributionTargets(definitions.map(definition => definition.name), contributions.uses, dialects)
  return await Promise.all(definitions.map(async definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      // SQLite is the default and stays implicit.
      ...(dialects[definition.name] === "postgresql" ? [{ label: "Dialect", value: "PostgreSQL" }] : []),
      ...isImplicitDefaultDatabase(definition)
        ? [{ label: "Definition", value: describeImplicitDefault([...contributionsByDatabase[definition.name] ?? [], ...usesByDatabase[definition.name] ?? []]) }]
        : [],
      { label: "Tables", value: describeTables(definition.schemaSources.map(source => source.handler)) },
      ...(dialects[definition.name] !== "postgresql" && isWebContainer() ? [{ label: "Local driver", value: webContainerDriver }] : []),
      ...(readDatabaseDefinitionReadReplication(definition.handler) ?? options.readReplication)
        ? [{ label: "Read replication", value: "On. Reads use D1 read replicas, through one D1 session per request. Writes return a bookmark cookie." }]
        : [],
      ...(definition.contributor ? [{ label: "Contributed by", value: definition.contributor }] : []),
      ...(definition.reason ? [{ label: "Reason", value: definition.reason }] : []),
      ...(definition.migrationsDir ? [{ label: "Migrations", value: relativeDefinitionFile(options.projectRoot, definition.migrationsDir) }] : []),
      ...definition.schemaSources.length > 1
        ? [{ label: "Schema sources", value: definition.schemaSources.map(source => relativeDefinitionFile(options.projectRoot, source.handler)).join(", ") }]
        : [],
      ...await Promise.all((contributionsByDatabase[definition.name] ?? []).map(contribution => describeContributedTables(contribution, options.rootDir))),
      ...(usesByDatabase[definition.name] ?? []).map(describeUse),
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  })))
}

export interface DatabaseResourceInspectionOptions {
  contributions?: CollectedDatabaseContributions
  env?: Record<string, string | undefined>
  options: DBModulePublicOptions | undefined
  /** Root that holds `.vitehub/provision.json`. */
  provisionRoot: string
  rootDir: string
  serverDirs?: string[]
}

function describeConfiguredId(value: DatabaseConfigValue | undefined, env: Record<string, string | undefined>): Pick<ViteHubResourceSummary, "env" | "id" | "source"> {
  if (typeof value === "string") return value.trim() ? { id: value, source: "config" } : {}
  if (!value) return {}
  for (const name of value.source?.names ?? (value.source?.name ? [value.source.name] : [])) {
    const id = env[name]
    if (id) return { env: name, id, source: "env" }
  }
  return typeof value.default === "string" && value.default.trim() ? { id: value.default, source: "config" } : {}
}

/**
 * Lists the D1 databases that Database Definitions bind natively, with where each id comes from.
 * Reads local config and Provision State only. D1 over HTTP, PostgreSQL, and opaque Definitions are left out.
 */
export function inspectDatabaseResources(options: DatabaseResourceInspectionOptions): ViteHubResourceSummary[] {
  const env = options.env ?? process.env
  const context = { contributions: options.contributions, implicitDefault: true, serverDirs: options.serverDirs }
  // Without Provision State, the resolved id is the one that config or env sets.
  const configured = resolveDBViteConfig(options.options, options.rootDir, { ...context, provisionState: {} })
  if (!configured) return []
  const provisionState = readProvisionStateSync(options.provisionRoot)
  const resources: ViteHubResourceSummary[] = []
  for (const name of configured.databaseNames) {
    const database = configured.databases[name]
    const cloudflare = database?.cloudflare
    if (database?.dialect !== "sqlite" || !cloudflare || cloudflare.http) continue
    if (configured.definitionDefaults.cloudflareProjections[name]?.resource === "opaque") continue
    const fromConfig = describeConfiguredId(cloudflare.databaseId, env)
    const provisionedId = fromConfig.id ? undefined : readProvisionedId(provisionState, "cloudflare", "d1", name)
    const resourceName = resolveConfigValue(cloudflare.databaseName, env)
    resources.push({
      binding: cloudflare.binding,
      definition: name,
      host: "cloudflare",
      kind: "cloudflare-d1",
      ...(resourceName ? { name: resourceName } : {}),
      owner: "database",
      ...fromConfig,
      ...(provisionedId ? { id: provisionedId, source: "provision-state" } : {}),
    })
  }
  return resources
}
