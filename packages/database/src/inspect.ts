import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverDatabaseDefinitions, readStaticDatabaseSchema } from "./config.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface DatabaseInspectionOptions {
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

/** Lists Database Definitions with their mode and the tables their source declares, without loading them. */
export function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs }).map(definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: describeTables(definition.handler) },
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  }))
}
