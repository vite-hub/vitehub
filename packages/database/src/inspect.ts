import { join } from "pathe"

import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { collectDatabaseContributions, describeDatabaseContribution, resolveDatabaseContributionTargets } from "./contributions.ts"
import { discoverDatabaseDefinitions, readStaticDatabaseSchema } from "./config.ts"
import { loadContributedDatabaseSchema } from "./internal/schema-tables.ts"

import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { ResolvedDatabaseContribution } from "./contributions.ts"

export interface DatabaseInspectionOptions {
  /** Vite plugins that can contribute tables through `vitehub.databases`. */
  plugins?: readonly unknown[]
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

// Inspection reads source only. Tables from an imported or spread schema are known after the Definition loads.
function describeTables(file: string) {
  const { complete, tableNames } = readStaticDatabaseSchema(file)
  if (complete) return tableNames.length ? tableNames.join(", ") : "None discovered"
  return tableNames.length ? `${tableNames.join(", ")}, plus an imported or spread schema` : "Imported or spread schema"
}

// A contribution module is a table module, not a Definition, so inspection loads it to name its tables.
async function describeContributedTables(contribution: ResolvedDatabaseContribution, rootDir: string): Promise<ViteHubDefinitionField> {
  const tables = await loadContributedDatabaseSchema(contribution, join(rootDir, "package.json"), { onFallback: () => {} })
    .then(schema => schema.loaded ? schema.tableNames.join(", ") || "No tables" : "Module did not load", (error: unknown) => error instanceof Error ? error.message : String(error))
  return { label: "Contributed tables", value: `${tables} from ${describeDatabaseContribution(contribution)}` }
}

/**
 * Lists Database Definitions with their mode, the tables their source declares, and the tables Vite plugins
 * contribute. Definitions are read from source without loading them.
 */
export async function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const definitions = discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs })
  const contributions = await collectDatabaseContributions(options.plugins, { rootDir: options.rootDir, serverDirs: options.serverDirs })
  const contributionsByDatabase = resolveDatabaseContributionTargets(definitions.map(definition => definition.name), contributions)
  return await Promise.all(definitions.map(async definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: describeTables(definition.handler) },
      ...await Promise.all((contributionsByDatabase[definition.name] ?? []).map(contribution => describeContributedTables(contribution, options.rootDir))),
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  })))
}
