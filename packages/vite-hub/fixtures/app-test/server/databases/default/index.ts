import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({
  schema: {
    users: sqliteTable("users", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      email: text("email").notNull().unique(),
    }),
  },
})
