import { defineHandler } from "h3"
import { db, schema } from "vite-hub/database"
import { kv } from "vite-hub/kv"

export default defineHandler(async () => {
  const rows = await db.select().from(schema.notes)
  const [error] = await kv.set("touch", "1")
  if (error) throw error
  return { notes: rows.length }
})
