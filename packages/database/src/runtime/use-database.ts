import { resolveDefaultDatabase } from "../default-database-name.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { sharedRuntimeKey } from "./shared-runtime.ts"

/**
 * Creates `useDatabase()` for a runtime registry. `names` are the Databases that have a Definition. `databases` can hold
 * more entries, such as the placeholder `default` that backs the `db` export, but `useDatabase()` only returns these.
 */
export function createUseDatabase<TEntry>(databases: Readonly<Record<string, TEntry>>, names: readonly string[]) {
  return function useDatabase(name?: PropertyKey): TEntry {
    if (name === undefined) {
      const resolution = resolveDefaultDatabase(names)
      if (resolution.status === "resolved") return databases[resolution.name]!
      throw resolution.status === "ambiguous"
        ? databaseErrorDiagnostics.DATABASE_NAME_REQUIRED({ choices: resolution.names })
        : databaseErrorDiagnostics.DATABASE_NOT_FOUND({ choices: [], database: "default" })
    }
    if (typeof name === "string" && names.includes(name)) return databases[name]!
    throw databaseErrorDiagnostics.DATABASE_NOT_FOUND({ choices: [...names].sort(), database: String(name) })
  }
}

/**
 * Gives these Databases to a copy of this package that has none. In dev, Node loads a second copy for the packages that
 * it loads itself, such as Agent and Workspace, and that copy reads the Databases of the copy that the host built.
 */
export function shareRuntimeDatabases(read: () => { configured: ReadonlySet<string>, databases: Readonly<Record<string, unknown>> }): void {
  Reflect.set(globalThis, sharedRuntimeKey, read)
}
