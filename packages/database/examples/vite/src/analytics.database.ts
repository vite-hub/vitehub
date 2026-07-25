import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const analyticsEvents = sqliteTable("analytics_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
})

export default defineDatabase({
  name: "analytics",
  cloudflare: {
    binding: "DB_ANALYTICS",
    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
    databaseName: "vitehub-analytics",
  },
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_ANALYTICS_DATABASE_URL || "libsql://analytics.example.turso.io",
  },
  schema: { analyticsEvents },
})
