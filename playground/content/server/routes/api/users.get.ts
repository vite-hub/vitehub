import { requireAuthorization, useAuth } from "vite-hub/auth/server"
import { defineHandler } from "h3"

// Admins list the users. `useAuth(event).api` has the endpoints of the `admin()` plugin in server/auth.ts, without a cast.
export default defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === "admin")
  return useAuth(event).api.listUsers({ query: { limit: 20 }, headers: event.req.headers })
})
