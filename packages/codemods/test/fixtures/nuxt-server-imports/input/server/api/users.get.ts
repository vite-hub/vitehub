import { defineEventHandler } from "nitro/h3"

export default defineEventHandler(async () => {
  return db.select().from(schema.users)
})
