import { resolve } from "node:path"

import { installConsoleDatabaseScope, resolveConsoleDatabase } from "../../internal.ts"

import type { RuntimeDatabaseEntry } from "@vite-hub/database/drizzle"
import type { ConsoleDatabaseInspection } from "../../internal.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

export function installConsoleDatabase(
  projectRoot: string,
  databases: Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>,
  names: readonly string[],
): ConsoleDatabaseInspection {
  const installedNames = [...new Set(names.filter(name => name.length > 0))]
    .filter(name => Object.hasOwn(databases, name))
    .sort((left, right) => left === "default" ? -1 : right === "default" ? 1 : left.localeCompare(right))
  return installConsoleDatabaseScope(resolve(projectRoot), { databases, names: installedNames })
}

export function getConsoleDatabase(): ConsoleDatabaseInspection {
  const inspection = resolveConsoleDatabase()
  if (!inspection) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0051({ message: "[vitehub] Database inspection has not been installed for this runtime." })
  }
  return inspection
}
