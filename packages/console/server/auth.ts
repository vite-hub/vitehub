import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"

// People sign in to the Console, never to each app. Only admins open projects: `VITEHUB_ADMINS` lists GitHub accounts,
// and `vitehub auth claim` makes a one-time code for the first admin of an email and password account.
export default defineAuth({
  appName: "ViteHub Console",
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [admin()],
})
