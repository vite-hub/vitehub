import { db, schema } from 'vite-hub/database'
import { eq } from 'drizzle-orm'

export default eventHandler(async (event) => {
  const { messageID, text }: { messageID: number, text: string } = await readBody(event)

  await db.update(schema.messages)
    .set({ text })
    .where(eq(schema.messages.id, messageID))

  return {}
})
