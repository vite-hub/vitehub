import { eq } from "drizzle-orm"
import { pgTable, text as pgText } from "drizzle-orm/pg-core"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expectTypeOf, it } from "vitest"

import { authPostgresSchema, authSqliteSchema, createAuthPostgresSchema, createAuthSqliteSchema } from "../src/schema.ts"

import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"

describe("Auth table types", () => {
  it("types the columns, so an app table can reference `user` and `organization`", () => {
    const budget = sqliteTable("budget", {
      id: text("id").primaryKey(),
      userId: text("user_id").notNull().references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
      householdId: text("household_id").references(() => authSqliteSchema.organization.id),
    })
    const pgBudget = pgTable("budget", {
      userId: pgText("user_id").notNull().references(() => authPostgresSchema.user.id),
    })
    expectTypeOf(budget.userId).not.toBeAny()
    expectTypeOf(pgBudget.userId).not.toBeAny()

    expectTypeOf<typeof authSqliteSchema.user.$inferSelect>().toEqualTypeOf<{
      id: string
      name: string
      email: string
      emailVerified: boolean
      image: string | null
      createdAt: Date
      updatedAt: Date
      role: string | null
      banned: boolean | null
      banReason: string | null
      banExpires: Date | null
    }>()
    expectTypeOf<typeof authPostgresSchema.member.$inferSelect>().toEqualTypeOf<{
      id: string
      organizationId: string
      userId: string
      role: string
      createdAt: Date
    }>()
    expectTypeOf<typeof authSqliteSchema.oauthClient.$inferSelect.redirectUris>().toEqualTypeOf<string[]>()
    expectTypeOf<typeof authSqliteSchema.passkey.$inferInsert>().toHaveProperty("counter").toEqualTypeOf<number>()
  })

  it("types app queries on the Auth tables", async () => {
    const db = {} as SQLiteAsyncDatabase<"async", unknown>
    const { member, user } = authSqliteSchema
    const rows = await db.select({ email: user.email, role: member.role }).from(member).innerJoin(user, eq(member.userId, user.id))
    expectTypeOf(rows).toEqualTypeOf<{ email: string, role: string }[]>()
  })

  it("types the additional fields and plugin tables of the generated schema", async () => {
    // `.vitehub/auth/schema.ts` passes the fields of `server/auth.ts` as a literal, as ViteHub Brief declares them.
    const schema = createAuthSqliteSchema({
      plugins: ["apiKey", "twoFactor"],
      additionalFields: {
        user: { modelId: { type: "string" }, outputLanguage: { type: "string", required: true, defaultValue: "en" } },
        session: { device: { type: "string", index: true } },
      },
    })
    const db = {} as SQLiteAsyncDatabase<"async", unknown>
    const rows = await db.select({ modelId: schema.user.modelId, outputLanguage: schema.user.outputLanguage }).from(schema.user).where(eq(schema.user.id, "user-1"))
    expectTypeOf(rows).toEqualTypeOf<{ modelId: string | null, outputLanguage: string }[]>()
    expectTypeOf<typeof schema.user.$inferInsert>().toHaveProperty("outputLanguage").toEqualTypeOf<string | undefined>()
    expectTypeOf<typeof schema.user.$inferSelect>().toHaveProperty("twoFactorEnabled").toEqualTypeOf<boolean | null>()
    expectTypeOf<typeof schema.user.$inferSelect>().toHaveProperty("email").toEqualTypeOf<string>()
    expectTypeOf<typeof schema.session.$inferSelect>().toHaveProperty("device").toEqualTypeOf<string | null>()
    expectTypeOf<typeof schema.apikey.$inferSelect>().toHaveProperty("referenceId").toEqualTypeOf<string>()
    expectTypeOf<typeof schema.twoFactor.$inferSelect>().toHaveProperty("userId").toEqualTypeOf<string>()
    expectTypeOf(schema).not.toHaveProperty("subscription")
    expectTypeOf(createAuthPostgresSchema({ plugins: ["stripe"] }).subscription.plan).not.toBeAny()
    expectTypeOf<typeof authSqliteSchema.user.$inferSelect>().not.toHaveProperty("modelId")
  })

  it("uses SQLite migration constraints for core, plugin, and additional columns", () => {
    const schema = createAuthSqliteSchema({
      plugins: ["twoFactor"],
      additionalFields: {
        user: { language: { type: "string", required: true }, outputURL: { type: "string", required: true, defaultValue: "" } },
      },
    }, {
      user: { columns: { email: { notNull: false }, output_url: { notNull: true } }, indexes: [], uniques: [], foreignKeys: [] },
      two_factor: { columns: { user_id: { notNull: true, default: "'user'" } }, indexes: [], uniques: [], foreignKeys: [] },
    })
    expectTypeOf<typeof schema.user.$inferSelect.language>().toEqualTypeOf<string | null>()
    expectTypeOf<typeof schema.user.$inferSelect.email>().toEqualTypeOf<string | null>()
    expectTypeOf<typeof schema.user.$inferInsert.outputURL>().toEqualTypeOf<string>()
    expectTypeOf<typeof schema.twoFactor.$inferInsert.userId>().toEqualTypeOf<string | undefined>()
  })

  it("types only guaranteed plugins and additional fields", () => {
    const plugins = ["twoFactor", "username", "anonymous", "phoneNumber", "lastLoginMethod", "apiKey", "stripe"] as const
    expectTypeOf(createAuthSqliteSchema({ plugins })).toHaveProperty("twoFactor")
    expectTypeOf(createAuthPostgresSchema({ plugins })).toHaveProperty("apikey")
    expectTypeOf(createAuthPostgresSchema({ plugins })).toHaveProperty("subscription")

    const enabled = Math.random() > 0.5
    const conditional = enabled ? ["twoFactor"] as const : [] as const
    const optionalModel: { user?: { language: { type: "string" } } } = enabled ? { user: { language: { type: "string" } } } : {}
    const optionalField: { user: { language?: { type: "string" } } } = { user: optionalModel.user ?? {} }
    expectTypeOf(createAuthSqliteSchema({ plugins: conditional })).not.toHaveProperty("twoFactor")
    expectTypeOf(createAuthPostgresSchema({ plugins: conditional }).user).not.toHaveProperty("twoFactorEnabled")
    expectTypeOf(createAuthSqliteSchema({ additionalFields: optionalModel }).user).not.toHaveProperty("language")
    expectTypeOf(createAuthPostgresSchema({ additionalFields: optionalField }).user).not.toHaveProperty("language")
  })
})
