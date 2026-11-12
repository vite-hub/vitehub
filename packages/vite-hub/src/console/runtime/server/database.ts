import { consoleState } from "../../internal.ts"

import type { ConsoleDatabaseEntry, ConsoleDatabaseInspection } from "../../internal.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

export function installConsoleDatabase(
  projectRoot: string,
  databases: Record<string, ConsoleDatabaseEntry>,
  names: readonly string[],
): ConsoleDatabaseInspection {
  const installedNames = [...new Set(names.filter(name => name.length > 0))]
    .filter(name => Object.hasOwn(databases, name))
    .sort((left, right) => left === "default" ? -1 : right === "default" ? 1 : left.localeCompare(right))
  return consoleState().database = { databases, names: installedNames }
}

export function getConsoleDatabase(): ConsoleDatabaseInspection {
  const inspection = consoleState().database
  if (!inspection) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0051({ message: "[vitehub] Database inspection has not been installed for this runtime." })
  }
  return inspection
}
