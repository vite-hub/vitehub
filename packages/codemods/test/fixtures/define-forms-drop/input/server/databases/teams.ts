import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Teams on a personal Drop (server/utils/teams.ts): Better Auth's organization plugin keeps who is on which team.

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull()

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
})

export const member = sqliteTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
})

export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
})
