import { defineHandler } from "h3"
import { db, schema } from "vite-hub/database/drizzle"

export default defineHandler(async () => {
  const rows = await db.select().from(schema.notes)
  return { count: rows.length }
})
