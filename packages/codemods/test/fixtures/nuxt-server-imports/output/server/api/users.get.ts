import { defineEventHandler } from "nitro/h3"
import { schema } from "vite-hub/database"

export default defineEventHandler(async () => {
  return db.select().from(schema.users)
})
