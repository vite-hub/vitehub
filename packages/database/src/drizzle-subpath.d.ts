import "./virtual-module.d.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import schema from "#vitehub/database/schema"
import type { AgentDatabaseHandle } from "./runtime/agent.js"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

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

export * from "#vitehub/database/schema"
export { schema }

export declare const databases: RuntimeDatabaseLookup

export declare function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]

export declare const db: DrizzleRuntimeDatabase<typeof schema>

export declare const agentDb: AgentDatabaseHandle & {
  database(name: string): AgentDatabaseHandle
}
