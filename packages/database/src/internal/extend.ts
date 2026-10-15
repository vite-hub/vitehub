import { existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { resolve } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { DatabaseExtendContext, DatabaseExtendHook, DatabaseExtendingPlugin, ResolvedDBViteConfig } from "../types.ts"

/** Reads `vitehub.database.extend` from Vite plugins, including nested plugin arrays. */
export function collectDatabaseExtendHooks(plugins: unknown): DatabaseExtendHook[] {
  const hooks: DatabaseExtendHook[] = []
  const visit = (option: unknown) => {
    if (Array.isArray(option)) {
      option.forEach(visit)
      return
    }
    // SAFETY: Vite plugin options are open objects; only the documented extension hook is read.
    const extend = (option as DatabaseExtendingPlugin | null | undefined)?.vitehub?.database?.extend
    if (extend instanceof Function && !hooks.includes(extend)) hooks.push(extend)
  }
  visit(plugins)
  return hooks
}

function resolveSchemaFile(rootDir: string, database: string, value: unknown) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Extension hooks are untyped JavaScript input; validate each pushed schema path.
  if (typeof value !== "string" || !value.trim()) {
    throw databaseErrorDiagnostics.DATABASE_C0010({ message: `[vitehub] A schema file added to Database ${JSON.stringify(database)} must be a nonblank path.` })
  }
  const file = value.startsWith("file:") ? fileURLToPath(value) : resolve(rootDir, value)
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw databaseErrorDiagnostics.DATABASE_C0010({ message: `[vitehub] Schema file ${JSON.stringify(file)} added to Database ${JSON.stringify(database)} does not exist.` })
  }
  return file
}

/**
 * Asks each extension hook for the schema files of every discovered Database.
 * Hooks run in order, once per Database, every time the Database config resolves.
 */
export async function extendDatabaseSchema(
  config: ResolvedDBViteConfig,
  hooks: readonly DatabaseExtendHook[],
): Promise<ResolvedDBViteConfig> {
  const extensions: Record<string, string[]> = Object.create(null)
  for (const name of config.databaseNames) {
    const schemaFiles: string[] = []
    const context: DatabaseExtendContext = Object.freeze({
      dialect: config.databases[name]!.dialect,
      name,
      schemaFiles,
    })
    for (const hook of hooks) await hook(context)
    const files = [...new Set(schemaFiles.map(file => resolveSchemaFile(config.rootDir, name, file)))]
    if (files.length) extensions[name] = files
  }
  config.schemaExtensionsByDatabase = extensions
  return config
}
