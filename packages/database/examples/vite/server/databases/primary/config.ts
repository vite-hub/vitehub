import { defineDatabase } from "@vitehub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
})

export default defineDatabase({
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_DATABASE_URL || "libsql://database.example.turso.io",
  },
  tables: { notes },
})
