import { defineDatabase } from "vite-hub/database"

// Users, sessions, accounts, and the OAuth tables of the Console MCP. `authDatabase("users")` in server/auth.ts adds the
// Better Auth tables.
export default defineDatabase({
  name: "users",
  cloudflare: {
    binding: "DB_USERS",
    databaseId: "cd649277-011f-48ee-981d-cbba214bffc4",
    databaseName: "vitehub-docs-demo-users",
  },
  schema: {},
})
