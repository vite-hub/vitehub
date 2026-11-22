import { defineDatabase } from "vite-hub/database"
import { contentSessionsSchema } from "vite-hub/content/database"
import { workspaceHistorySchema } from "vite-hub/workspace/blob-database"

export default defineDatabase({
  name: "content",
  schema: {
    workspaceHistoryWorkspaces: workspaceHistorySchema.workspaceHistoryWorkspaces,
    workspaceHistoryRefs: workspaceHistorySchema.workspaceHistoryRefs,
    workspaceHistoryRevisions: workspaceHistorySchema.workspaceHistoryRevisions,
    workspaceHistoryObjects: workspaceHistorySchema.workspaceHistoryObjects,
    workspaceHistoryMetadata: workspaceHistorySchema.workspaceHistoryMetadata,
    contentSessions: contentSessionsSchema.contentSessions,
  },
})
