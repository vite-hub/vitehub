import { requireAuthorization, useAuth } from "vite-hub/auth/server"
import { defineHandler } from "h3"

export default defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === "admin")
  return useAuth(event).api.listUsers({ query: { limit: 20 }, headers: event.req.headers })
})
