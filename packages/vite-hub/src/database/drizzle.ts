import {
  databases as runtimeDatabases,
  schema,
  useDatabase as useRuntimeDatabase,
} from "@vite-hub/database/drizzle"

import type { RuntimeDatabaseEntry } from "@vite-hub/database/drizzle"

export * from "@vite-hub/database/drizzle"

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>>
}

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: RuntimeDatabaseEntry<typeof schema>
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export const databases = runtimeDatabases as RuntimeDatabaseLookup

export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  return useRuntimeDatabase(name as never) as RuntimeDatabaseRegistry[Name]
}
