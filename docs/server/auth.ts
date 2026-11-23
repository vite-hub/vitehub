import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"

export default defineAuth({
  appName: "ViteHub",
  database: authDatabase(),
})
