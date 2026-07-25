import type { UserConfig } from "vite"

import { env } from "@vite-hub/env"
import "../src/virtual.ts"
import { defineDatabase } from "../src/index.ts"

import { describe, expectTypeOf, it } from "vitest"

import type { CloudflareD1HttpConfig, DBModulePublicOptions } from "../src/index.ts"

type DrizzleModule = typeof import("../src/drizzle.ts")

describe("types", () => {
  it("augments vite user config with database options", () => {
    const config: UserConfig = {
      database: {
        cli: {
          generate: false,
        },
        connection: {
          authToken: "token",
          url: "libsql://database.example.turso.io",
        },
      },
    }

    expectTypeOf(config.database).toMatchTypeOf<DBModulePublicOptions | undefined>()
  })

  it("accepts Runtime Env declarations for hosted connections", () => {
    const config: DBModulePublicOptions = {
      connection: {
        authToken: env({ secret: true, source: env.source("TURSO_AUTH_TOKEN") }),
        url: env({ source: env.source("TURSO_DATABASE_URL") }),
      },
    }

    expectTypeOf(config).toMatchTypeOf<DBModulePublicOptions>()
  })

  it("accepts explicit D1 HTTP transport configuration", () => {
    const direct = defineDatabase({
      cloudflare: {
        databaseId: env({ source: env.source("CLOUDFLARE_D1_DATABASE_ID") }),
        http: true,
      },
      schema: {},
    })
    const proxied = defineDatabase({
      cloudflare: {
        databaseId: env({ source: env.source("CLOUDFLARE_D1_DATABASE_ID") }),
        http: {
          authToken: env({ secret: true, source: env.source("D1_HTTP_TOKEN") }),
          url: env({ source: env.source("D1_HTTP_URL") }),
        },
      },
      schema: {},
    })

    expectTypeOf(direct.cloudflare?.http).toEqualTypeOf<true | CloudflareD1HttpConfig | undefined>()
    expectTypeOf(proxied.cloudflare?.http).toEqualTypeOf<true | CloudflareD1HttpConfig | undefined>()
  })

  it("exposes drizzle types when the virtual ambient module entry is loaded", () => {
    expectTypeOf<DrizzleModule["schema"]>().toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf<DrizzleModule["schema"]["notes"]>().toEqualTypeOf<unknown>()
    expectTypeOf<DrizzleModule["databases"]["default"]["schema"]>().toMatchTypeOf<DrizzleModule["schema"]>()
    expectTypeOf<DrizzleModule["db"]>().toMatchTypeOf<DrizzleModule["databases"]["default"]["db"]>()
  })
})
