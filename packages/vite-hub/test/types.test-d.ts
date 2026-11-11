import { describe, expectTypeOf, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { vitehub } from "vite-hub"
import { createMessage, defineAgent } from "vite-hub/agent"
import type { ConsoleAgentInvocationInput } from "vite-hub/console"
import { email } from "vite-hub/agent/capabilities"
import { useDatabase } from "vite-hub/database/drizzle"
import { env } from "vite-hub/env"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"
import type { History, HistoryCheckpoint, HistoryCheckpointOptions } from "vite-hub/workspace"

import { defineCollection } from "vite-hub/source"
import { table } from "vite-hub/source/drizzle"
import { defineCollectionHandler } from "vite-hub/source/server"
import type { CollectionAuthorizationGuard } from "vite-hub/source/server"
import { withAuthorization } from "vite-hub/auth/server"
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

declare const history: History<HistoryCheckpoint>
declare const onCloudflare: boolean
interface MealFilters {
  day?: string
}

declare const mealQuerySchema: StandardSchemaV1<MealFilters, MealFilters>
declare const transformedMealQuerySchema: StandardSchemaV1<{ q: string }, { search: string }>
type ReservedMealFilters = { cursor?: string } | { day?: string }
declare const reservedMealQuerySchema: StandardSchemaV1<ReservedMealFilters, ReservedMealFilters>
declare const limitMealQuerySchema: StandardSchemaV1<{ limit?: string }, { limit?: string }>
interface ReadonlyMealFilters {
  tags?: string | readonly string[]
}

declare const readonlyMealQuerySchema: StandardSchemaV1<ReadonlyMealFilters, ReadonlyMealFilters>
interface DuplicateMealFilters {
  tags?: string | readonly [string, string, ...string[]]
}

declare const duplicateMealQuerySchema: StandardSchemaV1<DuplicateMealFilters, DuplicateMealFilters>
interface ReadonlyOnlyMealFilters {
  tags?: readonly string[]
}

declare const readonlyOnlyMealQuerySchema: StandardSchemaV1<ReadonlyOnlyMealFilters, ReadonlyOnlyMealFilters>
interface TupleMealFilters {
  tags?: string | readonly [string]
}

declare const tupleMealQuerySchema: StandardSchemaV1<TupleMealFilters, TupleMealFilters>
interface FixedTupleMealFilters {
  tags?: string | readonly [string, string]
}

declare const fixedTupleMealQuerySchema: StandardSchemaV1<FixedTupleMealFilters, FixedTupleMealFilters>

describe("vite-hub public types", () => {
  it("type checks", () => {
    expectTypeOf(vitehub).toBeFunction()
    vitehub()
    vitehub({ host: "node", rateLimit: true })
    vitehub({ email: { driver: "resend" }, host: "node" })
    vitehub({ email: true, host: "cloudflare" })
    vitehub({ auth: onCloudflare, email: onCloudflare, host: onCloudflare ? "cloudflare" : "node" })
    vitehub({ name: "my-app", host: "cloudflare", blob: true, rateLimit: true })
    vitehub({ agent: true, database: true, host: "node", workflow: true, workspace: true })
    vitehub({ auth: true, console: true, host: "node" })
    vitehub({ console: {}, host: "node" })
    vitehub({ console: false, host: "node" })
    vitehub({ console: { auth: false }, host: "node" })
    vitehub({ auth: true, console: { authorize: "server/console-authorize.ts", impersonation: true }, host: "node" })
    vitehub({ console: { auth: false, authorize: "server/console-authorize.ts" }, host: "node" })
    vitehub({ console: { auth: false, authorize: "server/console-authorize.ts", invoke: true }, host: "node" })
    vitehub({ console: { authorize: "server/console-authorize.ts", invoke: false }, host: "node" })
    // @ts-expect-error console.authorize is a server file path, not an inline function.
    vitehub({ console: { auth: false, authorize: () => true }, host: "node" })
    // @ts-expect-error Apps do not sign people in to the Console: `auth: "app"` was removed.
    vitehub({ auth: true, console: { auth: "app" }, host: "node" })
    // @ts-expect-error Signed calls are the default: `auth: "token"` was removed.
    vitehub({ console: { auth: "token" }, host: "node" })
    // @ts-expect-error Console Auth (GitHub, a server file, Cloudflare Access) was removed.
    vitehub({ console: { auth: { provider: "cloudflare-access" } }, host: "cloudflare" })
    // @ts-expect-error Apps take no Console calls from browsers.
    vitehub({ console: { origins: ["https://console.vitehub.dev"] }, host: "node" })
    // @ts-expect-error Apps serve no Console MCP.
    vitehub({ console: { mcp: { resource: "https://app.example.com/_vitehub/mcp" } }, host: "node" })
    // @ts-expect-error The old access and exposure keys are removed.
    vitehub({ console: { access: "auth" }, host: "node" })
    // @ts-expect-error Unknown Console Auth modes must not silently expose inspection routes.
    vitehub({ console: { auth: "public" }, host: "node" })
    expectTypeOf<ConsoleAgentInvocationInput["prompt"]>().toBeString()
    const consoleInput: ConsoleAgentInvocationInput = { prompt: "Follow up", messages: [createMessage({ role: "user", text: "Earlier question" })] }
    expectTypeOf<NonNullable<typeof consoleInput.messages>[number]["role"]>().toEqualTypeOf<"user" | "assistant">()
    expectTypeOf(createMessage({ role: "user", text: "Earlier question" }).role).toEqualTypeOf<"user">()
    expectTypeOf(defineAgent).toBeFunction()
    expectTypeOf(email).toBeFunction()
    expectTypeOf(env).toBeFunction()
    expectTypeOf(requireRateLimit).toBeFunction()
    expectTypeOf(defineWorkspace).toBeFunction()
    expectTypeOf(defineWorkflow).toBeFunction()

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

    const privateMeals = defineCollection({
      authorize: ({ user }) => {
        expectTypeOf(user.id).toBeString()
        return true
      },
      source: table({
        db,
        orderBy: {
          column: schema.meals.createdAt,
          direction: "desc",
          tieBreaker: schema.meals.id,
        },
        table: schema.meals,
      }),
      transform: row => ({ id: row.id }),
    })
    expectTypeOf<CollectionItem<typeof privateMeals>>().toEqualTypeOf<{ id: string }>()

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

    // Generated Collection routes pass Auth's guard. The page handler runs only inside it.
    expectTypeOf(withAuthorization).toMatchTypeOf<CollectionAuthorizationGuard>()
    defineCollectionHandler(privateMeals, { withAuthorization })
    // @ts-expect-error The old option returned `Response | undefined` and let the page load after a missed check.
    defineCollectionHandler(privateMeals, { authorizeRequest: async () => undefined })
  })
})
