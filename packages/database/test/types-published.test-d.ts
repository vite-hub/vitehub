import { db, databases, schema } from "@vitehub/database/drizzle"

import { describe, expectTypeOf, it } from "vitest"

describe("published package types", () => {
  it("resolves virtual schema types from the drizzle subpath without manual ambient imports", () => {
    expectTypeOf(schema).toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf(databases.default.schema).toMatchTypeOf<typeof schema>()
    expectTypeOf(db).toMatchTypeOf<typeof databases.default.db>()
  })
})
