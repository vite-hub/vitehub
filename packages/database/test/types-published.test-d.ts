import { db, databases, schema } from "@vite-hub/database/drizzle"
import { hubDb } from "@vite-hub/database/nuxt"

import { describe, expectTypeOf, it } from "vitest"

import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"

describe("published package types", () => {
  it("resolves virtual schema types from the drizzle subpath without manual ambient imports", () => {
    expectTypeOf(schema).toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf(schema.notes).toEqualTypeOf<unknown>()
    expectTypeOf(databases.default.schema).toMatchTypeOf<typeof schema>()
    expectTypeOf(db).toMatchTypeOf<typeof databases.default.db>()
  })

  it("resolves the Nuxt bridge subpath", () => {
    const options = {
      driver: "d1",
      databaseName: "content-db",
      databaseId: "content-id",
    } satisfies DatabaseNuxtIntegrationOptions

    expectTypeOf(hubDb(options).getMeta().name).toEqualTypeOf<string>()
  })
})
