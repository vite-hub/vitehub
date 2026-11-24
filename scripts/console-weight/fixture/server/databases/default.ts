import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({
  cloudflare: { databaseId: "00000000-0000-0000-0000-000000000001", databaseName: "console-weight" },
  schema: { notes: sqliteTable("notes", { id: text().primaryKey() }) },
})
