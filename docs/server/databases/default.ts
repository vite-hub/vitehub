import { defineDatabase } from "vite-hub/database"

// Users, sessions, and Comments threads. The D1 database also holds the tables of the old @nuxt/content site.
export default defineDatabase({
  // The app adds no tables of its own. Auth and Comments add theirs.
  schema: {},
  cloudflare: {
    binding: "DB",
    databaseName: "vitehub-docs",
    databaseId: "4a8731af-1899-4d41-ac8b-6870167ead95",
  },
})
