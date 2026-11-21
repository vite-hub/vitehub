import { useDatabase } from "vite-hub/database"

export default defineEventHandler(async () => {
  const database = useDatabase("primary")
  return await database.select().from(database.schema.notes)
})
