import { expectTypeOf } from "vitest"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import { useDatabase as useOwnerDatabase } from "@vite-hub/database/drizzle"
import { getRuntimeContext as getOwnerRuntimeContext } from "@vite-hub/runtime/h3"
import { table as ownerTable } from "@vite-hub/source/drizzle"
import { cachedSource as ownerCachedSource } from "@vite-hub/source/server"
import { useDatabase } from "vite-hub/database/drizzle"
import { getRuntimeContext } from "vite-hub/runtime/h3"
import { table } from "vite-hub/source"
import { cachedSource } from "vite-hub/source/server"

const facadeSchema = {
  facadeNotes: sqliteTable("facade_notes", { id: text("id").primaryKey() }),
}

// An app augments the vite-hub path. The owner package must see the same registry.
declare module "vite-hub/database/drizzle" {
  interface DatabaseRegistry {
    facadeRegistry: { schema: typeof facadeSchema }
  }
}

expectTypeOf(useDatabase).toEqualTypeOf(useOwnerDatabase)
expectTypeOf(useOwnerDatabase("facadeRegistry").schema).toEqualTypeOf<typeof facadeSchema>()
expectTypeOf(useDatabase("facadeRegistry").schema).toEqualTypeOf<typeof facadeSchema>()
expectTypeOf(getRuntimeContext).toEqualTypeOf(getOwnerRuntimeContext)
expectTypeOf(table).toEqualTypeOf(ownerTable)
expectTypeOf(cachedSource).toEqualTypeOf(ownerCachedSource)
