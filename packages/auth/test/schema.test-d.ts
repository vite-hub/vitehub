import { eq } from "drizzle-orm"
import { pgTable, text as pgText } from "drizzle-orm/pg-core"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expectTypeOf, it } from "vitest"

import { authPostgresSchema, authSqliteSchema } from "../src/schema.ts"

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
})
