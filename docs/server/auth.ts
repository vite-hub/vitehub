import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"

// Nobody signs up on vitehub.dev. Site access in the Console signs the team and invited guests in, and admin() keeps
// what each one may do, such as write Comments, as roles.
export default defineAuth({
  appName: "ViteHub",
  database: authDatabase(),
  plugins: [admin()],
})
