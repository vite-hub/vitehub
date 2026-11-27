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
    databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || "vitehub-playground-analytics",
    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
    previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,
  },
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,
  },
  schema: { analyticsEvents },
})
