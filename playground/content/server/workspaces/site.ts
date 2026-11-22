import { blob } from "vite-hub/blob"
import { useDatabase } from "vite-hub/database"
import { sendQueue } from "vite-hub/queue"
import { defineWorkspace } from "vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore } from "vite-hub/workspace/blob-database"

export default defineWorkspace({
  store: createBlobDatabaseWorkspaceStore({
    blob: blob.store("default"),
    database: () => useDatabase("content").db,
    workspace: "site",
  }),
  hooks: {
    "write:after": async ({ operation, path, ref }) => {
      const id = ref === "draft" && operation === "writeFile" ? /^docs\/en\/(.+)\.md$/.exec(path)?.[1] : undefined
      if (!id) return
      const [error] = await sendQueue("translate", { id })
      if (error) console.error(`[translate] Could not enqueue the translation of docs/en/${id}.md:`, error)
    },
  },
})
