import { join } from "pathe"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { collectDatabaseContributions, describeDatabaseContribution, resolveDatabaseContributionTargets } from "./contributions.ts"
import { loadContributedDatabaseSchema } from "./internal/schema-tables.ts"

import { discoverDatabaseDefinitions, readStaticDatabaseSchema } from "./config.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface DatabaseInspectionOptions {
  plugins?: readonly unknown[]
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
  viteRoot?: string
}

// Inspection reads source only. Tables from an imported or spread schema are known after the Definition loads.
function describeTables(files: string[]) {
  const schemas = files.map(readStaticDatabaseSchema)
  const tableNames = [...new Set(schemas.flatMap(schema => schema.tableNames))]
  if (schemas.every(schema => schema.complete)) return tableNames.length ? tableNames.join(", ") : "None discovered"
  return tableNames.length ? `${tableNames.join(", ")}, plus an imported or spread schema` : "Imported or spread schema"
}

/** Lists Database Definitions with their mode, the tables their sources declare, and the files that add tables to them, without loading them. */
export async function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const definitions = discoverDatabaseDefinitions(options.rootDir, { implicitDefault: true, serverDirs: options.serverDirs })
  const contributions = await collectDatabaseContributions(options.plugins, { projectRoot: options.projectRoot, root: options.viteRoot ?? options.rootDir, serverDirs: options.serverDirs })
  const byDatabase = resolveDatabaseContributionTargets(definitions.map(definition => definition.name), contributions)
  return await Promise.all(definitions.map(async definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: describeTables(definition.schemaSources.map(source => source.handler)) },
      ...definition.schemaSources.length > 1
        ? [{ label: "Schema sources", value: definition.schemaSources.map(source => relativeDefinitionFile(options.projectRoot, source.handler)).join(", ") }]
        : [],
      ...await Promise.all((byDatabase[definition.name] ?? []).map(async contribution => {
        let tables: string
        try {
          tables = await loadContributedDatabaseSchema(contribution, join(options.rootDir, "package.json"), { onFallback: () => {} })
            .then(schema => schema.loaded ? schema.tableNames.join(", ") || "No tables" : "Module did not load")
        }
        catch {
          // Inspection must remain useful when a contribution has an invalid export.
          tables = "Module did not load"
        }
        return { label: "Contributed tables", value: `${tables} from ${describeDatabaseContribution(contribution)}` }
      })),
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  })))
}
