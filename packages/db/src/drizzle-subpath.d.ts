/// <reference path="./virtual-module.d.ts" />

import type { LibSQLDatabase } from "drizzle-orm/libsql"
import schema from "virtual:@vitehub/db/schema"

export * from "virtual:@vitehub/db/schema"
export { schema }

export declare const db: LibSQLDatabase<typeof schema>
