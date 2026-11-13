// Better Auth tables (user, session, account, verification), its teams and billing (./teams.ts), and Drop's own.
import { defineDatabase } from "vite-hub/database"
import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { invitation, member, organization } from "./teams"

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(sql`(unixepoch() * 1000)`).notNull(),
})

export const abuseReports = sqliteTable("abuse_reports", {
  id: text("id").primaryKey(),
  target: text("target").notNull(),
  status: text("status").notNull(),
})

export const codeImages = sqliteTable("code_images", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
})

export { invitation, member, organization }

export default defineDatabase({
  schema: { abuseReports, codeImages, invitation, member, organization, user },
})
