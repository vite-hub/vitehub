import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverDatabaseDefinitions } from "./config.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface DatabaseInspectionOptions {
  projectRoot: string
  rootDir: string
  /** Schema files that extensions add, keyed by Database name. */
  schemaExtensionsByDatabase?: Record<string, string[]>
  serverDirs?: string[]
}

/** Lists Database Definitions with their mode, discovered tables, and extension schema files. */
export function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs }).map(definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: definition.tableNames.length ? definition.tableNames.join(", ") : "None discovered" },
      ...(options.schemaExtensionsByDatabase?.[definition.name]?.length
        ? [{ label: "Schema extensions", value: options.schemaExtensionsByDatabase[definition.name]!.map(file => relativeDefinitionFile(options.projectRoot, file)).join(", ") }]
        : []),
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  }))
}
