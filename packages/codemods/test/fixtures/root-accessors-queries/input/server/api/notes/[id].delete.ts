import { eq } from "drizzle-orm"
import { useDatabase } from "vite-hub/database"

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"))
  const { db, schema } = useDatabase("primary")
  await db.delete(schema.notes).where(eq(schema.notes.id, id))
  return { id }
})
