import { db, schema } from 'vite-hub/database'
import { eq } from 'drizzle-orm'

export default eventHandler(async (event) => {
  const { messageID } = await readBody(event)

  await db.delete(schema.messages)
    .where(eq(schema.messages.id, messageID))

  return {}
})
