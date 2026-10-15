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

/** Lists Database Definitions with their mode, discovered tables, and the files that add tables to them. */
export function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs }).map(definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: definition.tableNames.length ? definition.tableNames.join(", ") : "None discovered" },
      ...definition.schemaSources.length > 1
        ? [{ label: "Schema sources", value: definition.schemaSources.map(source => relativeDefinitionFile(options.projectRoot, source.handler)).join(", ") }]
        : [],
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  }))
}
