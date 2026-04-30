import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const analyticsEvents = sqliteTable("analytics_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
})
