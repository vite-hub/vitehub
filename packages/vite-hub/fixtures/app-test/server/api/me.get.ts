import { defineHandler } from "h3"
import { requireAuth } from "vite-hub/auth/server"

export default defineHandler(async (event) => {
  const { user } = await requireAuth(event)
  return { email: user.email }
})
