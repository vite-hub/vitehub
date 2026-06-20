import type { UserConfig } from "vite"

import "../src/virtual.ts"

import { describe, expectTypeOf, it } from "vitest"

import type { DBModulePublicOptions } from "../src/index.ts"

type DrizzleModule = typeof import("../src/drizzle.ts")

describe("types", () => {
  it("augments vite user config with database options", () => {
    const config: UserConfig = {
      database: {
        cli: {
          generate: false,
        },
      },
    }

    expectTypeOf(config.database).toMatchTypeOf<DBModulePublicOptions | undefined>()
  })

  it("exposes drizzle types when the virtual ambient module entry is loaded", () => {
    expectTypeOf<DrizzleModule["schema"]>().toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf<DrizzleModule["databases"]["default"]["schema"]>().toMatchTypeOf<DrizzleModule["schema"]>()
    expectTypeOf<DrizzleModule["db"]>().toMatchTypeOf<DrizzleModule["databases"]["default"]["db"]>()
  })
})
