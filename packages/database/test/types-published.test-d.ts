import { defineDatabase } from "@vite-hub/database"
import { agentDb, chunkParameters, db, databases, schema, useDatabase } from "@vite-hub/database/drizzle"
import { hubDb } from "@vite-hub/database/nuxt"
import { defineRelations, defineRelationsPart } from "drizzle-orm"
import { pgTable, text as pgText } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { describe, expectTypeOf, it } from "vitest"

import type { Database, DatabaseNuxtIntegrationOptions, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "@vite-hub/database"

const analyticsSchema = {
  events: sqliteTable("events", { name: text("name").notNull() }),
}

const reportsSchema = {
  reports: pgTable("reports", { title: pgText("title").notNull() }),
}

const authors = sqliteTable("authors", { id: integer("id").primaryKey(), name: text("name").notNull() })
const books = sqliteTable("books", { id: integer("id").primaryKey(), authorId: integer("author_id").notNull() })
const reviews = sqliteTable("reviews", { id: integer("id").primaryKey(), bookId: integer("book_id").notNull() })
const librarySchema = { authors, books, reviews }
const libraryRelations = defineRelations(librarySchema, r => ({
  authors: { books: r.many.books() },
  books: { author: r.one.authors({ from: r.books.authorId, to: r.authors.id, optional: false }) },
}))
// A contributed part, as `vitehub.databases` gets it from a table contribution's `relations` export.
const reviewRelations = defineRelationsPart(librarySchema, r => ({
  books: { reviews: r.many.reviews({ from: r.books.id, to: r.reviews.bookId }) },
}))

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
    library: {
      relations: typeof libraryRelations
      schema: typeof librarySchema
    }
    layered: {
      relations: [typeof reviewRelations, typeof libraryRelations]
      schema: typeof librarySchema
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
    expectTypeOf(chunkParameters(["a"], { per: analyticsSchema.events, reserved: 1 })).toEqualTypeOf<string[][]>()
    expectTypeOf(agentDb.database("analytics").exec).toBeFunction()
    expectTypeOf(useDatabase("analytics").schema.events).toEqualTypeOf(analyticsSchema.events)
    // @ts-expect-error The default database is not configured by this generated registry.
    useDatabase("default")
    // @ts-expect-error Unknown database names must be rejected by the generated registry.
    useDatabase("missing")
    // @ts-expect-error Several Databases without a `default` one need a name.
    useDatabase()
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

  it("types `with` from the relations of defineDatabase", () => {
    const database = defineDatabase({ relations: libraryRelations, schema: librarySchema })

    expectTypeOf(database).toMatchTypeOf<Database<typeof librarySchema, typeof libraryRelations>>()
    expectTypeOf(database.relations).toEqualTypeOf(libraryRelations)
    expectTypeOf(database.query.authors.findMany({ with: { books: true } })).resolves.toEqualTypeOf<Array<{
      id: number
      name: string
      books: Array<{ id: number, authorId: number }>
    }>>()
    expectTypeOf(database.query.books.findFirst({ columns: { id: true }, with: { author: { columns: { name: true } } } })).resolves.toEqualTypeOf<{
      id: number
      author: { name: string }
    } | undefined>()
    // @ts-expect-error Authors have no reviews relation.
    database.query.authors.findMany({ with: { reviews: true } })

    // Without `relations`, each table has no relations, so `with` does not exist.
    const plain = defineDatabase({ schema: librarySchema })
    // @ts-expect-error Plain Definitions have no relations.
    plain.query.authors.findMany({ with: { books: true } })
  })

  it("types `with` from registry relations, as one object or as merged parts", () => {
    expectTypeOf(useDatabase("library").relations).toEqualTypeOf(libraryRelations)
    expectTypeOf(useDatabase("library").db.query.authors.findFirst({ with: { books: { columns: { id: true } } } })).resolves.toEqualTypeOf<{
      id: number
      name: string
      books: Array<{ id: number }>
    } | undefined>()

    const layered = useDatabase("layered").db
    expectTypeOf(layered.query.books.findFirst({ columns: { id: true }, with: { author: { columns: { name: true } }, reviews: { columns: { id: true } } } })).resolves.toEqualTypeOf<{
      id: number
      author: { name: string }
      reviews: Array<{ id: number }>
    } | undefined>()
    expectTypeOf(layered.query.reviews.findMany()).resolves.toEqualTypeOf<Array<{ id: number, bookId: number }>>()
    // @ts-expect-error Reviews have no relations in any part.
    layered.query.reviews.findMany({ with: { book: true } })
  })

  it("types Postgres relations", () => {
    const users = pgTable("users", { id: pgText("id").primaryKey() })
    const sessions = pgTable("sessions", { id: pgText("id").primaryKey(), userId: pgText("user_id").notNull() })
    const definition = defineDatabase({
      dialect: "postgresql",
      relations: defineRelations({ sessions, users }, r => ({ users: { sessions: r.many.sessions({ from: r.users.id, to: r.sessions.userId }) } })),
      schema: { sessions, users },
    })

    expectTypeOf(definition.relations.users.relations.sessions.relationType).toEqualTypeOf<"many">()
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
