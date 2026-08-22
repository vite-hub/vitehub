import { expectTypeOf } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
import { email } from "vite-hub/agent/capabilities"
import { useDatabase } from "vite-hub/database/drizzle"
import { env } from "vite-hub/env"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"

import { defineCollection, table } from "vite-hub/source"
import type { CollectionItem, CollectionQuery, CollectionRequestQuery } from "vite-hub/source"
import type { StandardSchemaV1 } from "@standard-schema/spec"

const databaseSchema = {
  meals: sqliteTable("meals", {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  }),
}

declare module "vite-hub/database/drizzle" {
  interface DatabaseRegistry {
    typed: { schema: typeof databaseSchema }
  }
}

expectTypeOf(vitehub).toBeFunction()
vitehub({ preset: "node", rateLimit: true })
vitehub({ email: { driver: "unemail/driver/resend" }, preset: "node" })
vitehub({ email: true, preset: "cloudflare" })
vitehub({ name: "my-app", preset: "cloudflare", blob: true, rateLimit: true })
vitehub({ agent: true, database: true, preset: "node", workflow: true, workspace: true })
expectTypeOf(defineAgent).toBeFunction()
expectTypeOf(email).toBeFunction()
expectTypeOf(env).toBeFunction()
expectTypeOf(requireRateLimit).toBeFunction()
expectTypeOf(defineWorkspace).toBeFunction()
expectTypeOf(defineWorkflow).toBeFunction()

const { db, schema } = useDatabase("typed")
const meals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    table: schema.meals,
    where({ query, table }) {
      expectTypeOf(query).toEqualTypeOf<CollectionRequestQuery>()
      expectTypeOf(table).toEqualTypeOf<typeof databaseSchema.meals>()
      return undefined
    },
  }),
  transform(row) {
    expectTypeOf(row).toEqualTypeOf<typeof databaseSchema.meals.$inferSelect>()
    return { id: row.id }
  },
})
expectTypeOf<CollectionItem<typeof meals>>().toEqualTypeOf<{ id: string }>()

declare const mealQuerySchema: StandardSchemaV1<unknown, { day?: string }>
const filteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: mealQuerySchema,
    table: schema.meals,
    where({ query }) {
      expectTypeOf(query).toEqualTypeOf<{ day?: string }>()
      return undefined
    },
  }),
})
expectTypeOf<CollectionQuery<typeof filteredMeals>>().toEqualTypeOf<{ day?: string }>()
