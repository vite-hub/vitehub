import "./virtual-module.d.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import schema from "#vitehub/database/schema"
import type { AgentDatabaseHandle } from "./runtime/agent.js"

type DatabaseDialect = "sqlite" | "postgresql"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> = TDialect extends "postgresql"
  ? PgDatabase<PgQueryResultHKT, TSchema>
  : BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> {
  db: DrizzleRuntimeDatabase<TSchema, TDialect>
  schema: TSchema
}

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RegisteredDatabaseDialect<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  dialect: infer TDialect extends DatabaseDialect
} ? TDialect : "sqlite"

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>, RegisteredDatabaseDialect<Name>>
}

type DefaultDatabaseEntry = "default" extends keyof RuntimeDatabaseRegistry
  ? RuntimeDatabaseRegistry["default" & keyof RuntimeDatabaseRegistry]
  : RuntimeDatabaseEntry<typeof schema>

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: DefaultDatabaseEntry
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export * from "#vitehub/database/schema"
export { schema }

export declare const databases: RuntimeDatabaseLookup

export declare function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]

export declare const db: DefaultDatabaseEntry["db"]

export declare const agentDb: AgentDatabaseHandle & {
  database(name: string): AgentDatabaseHandle
}
