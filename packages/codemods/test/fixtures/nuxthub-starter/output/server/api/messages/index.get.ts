import { db, schema } from 'vite-hub/database'
import { desc } from 'drizzle-orm'

export default eventHandler(async () => {
  return db.select().from(schema.messages).orderBy(desc(schema.messages.createdAt))
})
