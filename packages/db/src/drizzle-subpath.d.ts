import "./virtual-module.d.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import schema from "#vitehub/db/schema"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

export * from "#vitehub/db/schema"
export { schema }

export declare const databases: Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<typeof schema>
}

export declare const db: DrizzleRuntimeDatabase<typeof schema>
