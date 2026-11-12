import { pgTable, serial, text } from "drizzle-orm/pg-core"
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({
  connection: { url: process.env.DATABASE_URL },
  dialect: "postgresql",
  schema: {
    notes: pgTable("notes", { id: serial("id").primaryKey(), title: text("title").notNull() }),
  },
})
