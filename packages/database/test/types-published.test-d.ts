import { defineDatabase } from "@vite-hub/database"
import { agentDb, db, databases, schema, useDatabase } from "@vite-hub/database/drizzle"
import { hubDb } from "@vite-hub/database/nuxt"
import { pgTable, text as pgText } from "drizzle-orm/pg-core"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import { describe, expectTypeOf, it } from "vitest"

import type { Database, DatabaseNuxtIntegrationOptions, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "@vite-hub/database"

const analyticsSchema = {
  events: sqliteTable("events", { name: text("name").notNull() }),
}

const reportsSchema = {
  reports: pgTable("reports", { title: pgText("title").notNull() }),
}

declare module "@vite-hub/database/drizzle" {
  interface DatabaseRegistry {
    analytics: {
      config: import("@vite-hub/database").ResolvedDrizzleDatabaseConfig
      schema: typeof analyticsSchema
    }
    reports: {
      dialect: "postgresql"
      schema: typeof reportsSchema
    }
  }
}

describe("published package types", () => {
  it("resolves virtual schema types from the drizzle subpath without manual ambient imports", () => {
    expectTypeOf(schema).toMatchTypeOf<Record<string, unknown>>()
    expectTypeOf(schema.notes).toEqualTypeOf<unknown>()
    expectTypeOf(databases.default.schema).toMatchTypeOf<typeof schema>()
    expectTypeOf(db).toMatchTypeOf<typeof databases.default.db>()
    expectTypeOf(agentDb.query).toBeFunction()
    expectTypeOf(agentDb.database("analytics").exec).toBeFunction()
    expectTypeOf(useDatabase("analytics").schema.events).toEqualTypeOf(analyticsSchema.events)
    // @ts-expect-error The default database is not configured by this generated registry.
    useDatabase("default")
    // @ts-expect-error Unknown database names must be rejected by the generated registry.
    useDatabase("missing")
  })

  it("returns a typed runtime database from defineDatabase", () => {
    const notes = sqliteTable("notes", { title: text("title").notNull() })
    const database = defineDatabase({ schema: { notes } })

    expectTypeOf(database).toMatchTypeOf<Database<{ notes: typeof notes }>>()
    expectTypeOf(database.schema.notes).toEqualTypeOf(notes)
    expectTypeOf(database.select).toBeFunction()
    expectTypeOf(database.batch).toBeFunction()
    expectTypeOf(db.batch).toBeFunction()
    expectTypeOf(useDatabase("analytics").db.batch).toBeFunction()
  })

  it("types Postgres Definitions and their generated database", () => {
    const definition = defineDatabase({
      cloudflare: { hyperdriveId: "hyperdrive-id" },
      connection: { url: "postgres://localhost/app" },
      dialect: "postgresql",
      schema: reportsSchema,
    })

    expectTypeOf(definition).toEqualTypeOf<PostgresDatabaseDefinition<typeof reportsSchema>>()
    expectTypeOf(useDatabase("reports").db).toEqualTypeOf<RuntimePostgresDatabase<typeof reportsSchema>>()
    expectTypeOf(useDatabase("reports").db.select().from(reportsSchema.reports)).resolves.toEqualTypeOf<Array<{ title: string }>>()
    // @ts-expect-error Postgres Definitions do not accept D1 HTTP access.
    defineDatabase({ cloudflare: { http: true }, dialect: "postgresql", schema: reportsSchema })
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
