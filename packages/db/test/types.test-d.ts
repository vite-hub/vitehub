import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import { db, databases, schema } from "../src/drizzle.ts"
import type { DBModuleOptions } from "../src/index.ts"
import "../src/virtual.ts"

describe("types", () => {
  it("augments vite user config with db options", () => {
    const config: UserConfig = {
      db: {
        connection: {
          url: "file:.data/app.db",
        },
      },
    }

    expectTypeOf(config.db).toMatchTypeOf<DBModuleOptions | false | undefined>()
  })

  it("exposes the drizzle runtime surface when virtual ambient types are loaded", () => {
    expectTypeOf(schema).toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf(databases.default.schema).toMatchTypeOf<typeof schema>()
    expectTypeOf(db).toMatchTypeOf(databases.default.db)
  })
})
