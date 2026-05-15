import type { UserConfig } from "vite"

import "../src/virtual.ts"

import { describe, expectTypeOf, it } from "vitest"

import type { DBModuleOptions } from "../src/index.ts"
import { createDbTools } from "../src/agent.ts"

type DrizzleModule = typeof import("../src/drizzle.ts")

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

  it("exposes drizzle types when the virtual ambient module entry is loaded", () => {
    expectTypeOf<DrizzleModule["schema"]>().toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf<DrizzleModule["databases"]["default"]["schema"]>().toMatchTypeOf<DrizzleModule["schema"]>()
    expectTypeOf<DrizzleModule["db"]>().toMatchTypeOf<DrizzleModule["databases"]["default"]["db"]>()
  })

  it("exposes DB agent tools", () => {
    const tools = createDbTools({ access: "schema", database: "default" })

    expectTypeOf(tools.db_list_tables.name).toEqualTypeOf<string>()
    expectTypeOf(tools.db_run_schema_sql.execute).toMatchTypeOf<unknown>()
  })
})
