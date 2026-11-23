import { defineDatabase } from "vite-hub/database"
import { contentSessionsSchema } from "vite-hub/content/database"
import { workspaceHistorySchema } from "vite-hub/workspace/blob-database"

export default defineDatabase({
  name: "content",
  schema: { ...workspaceHistorySchema, ...contentSessionsSchema },
})
