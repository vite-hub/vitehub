import { describe, expectTypeOf, it } from "vitest"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import { useDatabase as useOwnerDatabase } from "@vite-hub/database"
import { getRuntimeContext as getOwnerRuntimeContext, getStandardContext as getOwnerStandardContext } from "@vite-hub/runtime/internal/h3"
import { table as ownerTable } from "@vite-hub/source/drizzle"
import { cachedSource as ownerCachedSource } from "@vite-hub/source/server"
import { useDatabase } from "vite-hub/database"
import { getRuntimeContext, getStandardContext } from "vite-hub/runtime"
import { table } from "vite-hub/source/drizzle"
import { cachedSource } from "vite-hub/source/server"

const facadeSchema = {
  facadeNotes: sqliteTable("facade_notes", { id: text("id").primaryKey() }),
}

// An app augments the vite-hub path. The owner package must see the same registry.
declare module "vite-hub/database" {
  interface DatabaseRegistry {
    facadeRegistry: { schema: typeof facadeSchema }
  }
}

describe("vite-hub facades", () => {
  it("type checks", () => {
    expectTypeOf(useDatabase).toEqualTypeOf(useOwnerDatabase)
    expectTypeOf(useOwnerDatabase("facadeRegistry").schema).toEqualTypeOf<typeof facadeSchema>()
    expectTypeOf(useDatabase("facadeRegistry").schema).toEqualTypeOf<typeof facadeSchema>()
    expectTypeOf(getRuntimeContext).toEqualTypeOf(getOwnerRuntimeContext)
    expectTypeOf(getStandardContext).toEqualTypeOf(getOwnerStandardContext)
    expectTypeOf(table).toEqualTypeOf(ownerTable)
    expectTypeOf(cachedSource).toEqualTypeOf(ownerCachedSource)
  })
})
