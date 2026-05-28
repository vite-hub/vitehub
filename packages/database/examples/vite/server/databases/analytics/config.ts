import { defineDatabase } from "@vitehub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const analyticsEvents = sqliteTable("analytics_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
})

export default defineDatabase({
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_ANALYTICS_DATABASE_URL || "libsql://analytics.example.turso.io",
  },
  tables: { analyticsEvents },
})
