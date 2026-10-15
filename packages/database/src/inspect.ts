import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverDatabaseDefinitions, readDatabaseDefinitionDialect } from "./config.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface DatabaseInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Lists Database Definitions with their mode, non-default dialect, discovered tables, and the files that add tables to them. */
export function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs }).map(definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      // SQLite is the default and stays implicit.
      ...(readDatabaseDefinitionDialect(definition.handler) === "postgresql" ? [{ label: "Dialect", value: "PostgreSQL" }] : []),
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
