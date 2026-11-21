import { useDatabase } from "vite-hub/database"
import { notes } from "~~/server/databases/primary/schema"

export default defineEventHandler(async (event) => {
  const { title } = await readBody<{ title: string }>(event)
  const [note] = await useDatabase("primary").db.insert(notes).values({ title }).returning()
  return note
})
