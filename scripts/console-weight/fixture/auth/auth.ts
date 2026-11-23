import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"

export default defineAuth({ database: authDatabase() })
