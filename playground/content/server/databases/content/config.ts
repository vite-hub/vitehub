import { defineDatabase } from "vite-hub/database"
import { workspaceHistorySchema } from "vite-hub/workspace/blob-database"

// Literal keys, because `vitehub db generate` on this base only finds tables written out in `schema` (fixed by #2377).
export default defineDatabase({
  name: "content",
  schema: {
    workspaceHistoryWorkspaces: workspaceHistorySchema.workspaceHistoryWorkspaces,
    workspaceHistoryRefs: workspaceHistorySchema.workspaceHistoryRefs,
    workspaceHistoryRevisions: workspaceHistorySchema.workspaceHistoryRevisions,
    workspaceHistoryObjects: workspaceHistorySchema.workspaceHistoryObjects,
    workspaceHistoryMetadata: workspaceHistorySchema.workspaceHistoryMetadata,
  },
})
