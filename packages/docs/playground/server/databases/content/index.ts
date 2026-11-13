import { defineDatabase } from "vite-hub/database"

// Content: the CMS history and editor sessions (`database: "content"` in server/content.ts) and the Comments tables
// (`database: "content"` in server/comments.ts).
export default defineDatabase({
  name: "content",
  cloudflare: {
    binding: "DB_CONTENT",
    databaseId: "5e886649-57e0-4ec6-b9cd-d33f7a818e02",
    databaseName: "vitehub-docs-demo-content",
  },
  schema: {},
})
