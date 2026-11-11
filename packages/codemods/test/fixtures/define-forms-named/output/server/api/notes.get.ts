import { useDatabase } from "vite-hub/database"
import primary from "~~/server/databases/primary/index"

export default defineEventHandler(async () => {
  const database = useDatabase("primary")
  return await database.select().from(primary.schema.notes)
})
