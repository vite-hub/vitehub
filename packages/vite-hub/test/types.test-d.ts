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
import type { History, HistoryCheckpoint, HistoryCheckpointOptions } from "vite-hub/workspace"

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
vitehub({ email: { driver: "resend" }, preset: "node" })
vitehub({ email: true, preset: "cloudflare" })
vitehub({ name: "my-app", preset: "cloudflare", blob: true, rateLimit: true })
vitehub({ agent: true, database: true, preset: "node", workflow: true, workspace: true })
vitehub({ console: true, preset: "node" })
vitehub({ auth: true, console: { access: "auth" }, preset: "node" })
vitehub({ console: { exposure: "host-managed" }, preset: "node" })
// @ts-expect-error Production access contracts are mutually exclusive.
vitehub({ console: { access: "auth", exposure: "host-managed" }, preset: "node" })
// @ts-expect-error Unknown Console access modes must not silently expose inspection routes.
vitehub({ console: { access: "public" }, preset: "node" })
expectTypeOf(defineAgent).toBeFunction()
expectTypeOf(email).toBeFunction()
expectTypeOf(env).toBeFunction()
expectTypeOf(requireRateLimit).toBeFunction()
expectTypeOf(defineWorkspace).toBeFunction()
expectTypeOf(defineWorkflow).toBeFunction()

declare const history: History<HistoryCheckpoint>
const checkpointOptions: HistoryCheckpointOptions = { message: "save draft" }
expectTypeOf(history.checkpoint(checkpointOptions)).toEqualTypeOf<Promise<HistoryCheckpoint>>()

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

interface MealFilters {
  day?: string
}

declare const mealQuerySchema: StandardSchemaV1<MealFilters, MealFilters>
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
expectTypeOf<CollectionQuery<typeof filteredMeals>>().toEqualTypeOf<MealFilters>()

declare const transformedMealQuerySchema: StandardSchemaV1<{ q: string }, { search: string }>
const searchedMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: transformedMealQuerySchema,
    table: schema.meals,
    where({ query }) {
      expectTypeOf(query).toEqualTypeOf<{ search: string }>()
      return undefined
    },
  }),
})
expectTypeOf<CollectionQuery<typeof searchedMeals>>().toEqualTypeOf<{ q: string }>()

type ReservedMealFilters = { cursor?: string } | { day?: string }
declare const reservedMealQuerySchema: StandardSchemaV1<ReservedMealFilters, ReservedMealFilters>
const reservedFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: reservedMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof reservedFilteredMeals>>().toEqualTypeOf<{ day?: string }>()

declare const limitMealQuerySchema: StandardSchemaV1<{ limit?: string }, { limit?: string }>
const limitFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: limitMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof limitFilteredMeals>>().toEqualTypeOf<never>()

interface ReadonlyMealFilters {
  tags?: string | readonly string[]
}

declare const readonlyMealQuerySchema: StandardSchemaV1<ReadonlyMealFilters, ReadonlyMealFilters>
const readonlyFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: readonlyMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof readonlyFilteredMeals>>().toEqualTypeOf<ReadonlyMealFilters>()

interface DuplicateMealFilters {
  tags?: string | readonly [string, string, ...string[]]
}

declare const duplicateMealQuerySchema: StandardSchemaV1<DuplicateMealFilters, DuplicateMealFilters>
const duplicateFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: duplicateMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof duplicateFilteredMeals>>().toEqualTypeOf<DuplicateMealFilters>()

interface ReadonlyOnlyMealFilters {
  tags?: readonly string[]
}

declare const readonlyOnlyMealQuerySchema: StandardSchemaV1<ReadonlyOnlyMealFilters, ReadonlyOnlyMealFilters>
const readonlyOnlyFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: readonlyOnlyMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof readonlyOnlyFilteredMeals>>().toEqualTypeOf<never>()

interface TupleMealFilters {
  tags?: string | readonly [string]
}

declare const tupleMealQuerySchema: StandardSchemaV1<TupleMealFilters, TupleMealFilters>
const tupleFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: tupleMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof tupleFilteredMeals>>().toEqualTypeOf<never>()

interface FixedTupleMealFilters {
  tags?: string | readonly [string, string]
}

declare const fixedTupleMealQuerySchema: StandardSchemaV1<FixedTupleMealFilters, FixedTupleMealFilters>
const fixedTupleFilteredMeals = defineCollection({
  source: table({
    db,
    orderBy: {
      column: schema.meals.createdAt,
      direction: "desc",
      tieBreaker: schema.meals.id,
    },
    querySchema: fixedTupleMealQuerySchema,
    table: schema.meals,
  }),
})
expectTypeOf<CollectionQuery<typeof fixedTupleFilteredMeals>>().toEqualTypeOf<never>()
