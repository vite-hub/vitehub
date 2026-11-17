import { useDatabase } from "vite-hub/database"
import primary from "~~/server/databases/primary/config"

export default defineEventHandler(async () => {
  const database = useDatabase("primary")
  return await database.db.select().from(primary.schema.notes)
})
