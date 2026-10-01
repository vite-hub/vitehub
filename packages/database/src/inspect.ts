import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverDatabaseDefinitions } from "./config.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface DatabaseInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Lists Database Definitions with their mode and discovered tables. */
export function inspectDatabaseDefinitions(options: DatabaseInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverDatabaseDefinitions(options.rootDir, { serverDirs: options.serverDirs }).map(definition => ({
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: definition.tableNames.length ? definition.tableNames.join(", ") : "None discovered" },
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  }))
}
