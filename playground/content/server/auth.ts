import { defineAuth } from "vite-hub/auth"

// In-memory users and sessions. Restarting the server signs everyone out. Sign in at /login.
export default defineAuth({
  appName: "Content playground",
  emailAndPassword: { enabled: true },
})
