import { blob } from "vite-hub/blob"
import { sendQueue } from "vite-hub/queue"
import { defineWorkspace } from "vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore } from "vite-hub/workspace/blob-database"

import contentDatabase from "../databases/content/index"

export default defineWorkspace({
  store: createBlobDatabaseWorkspaceStore({
    blob: blob.store("default"),
    database: contentDatabase,
    workspace: "site",
  }),
  hooks: {
    // An English docs page changed on the draft: a Console or Content save, or `vitehub push`. The `translate` job
    // writes the Spanish page to docs/es/, so its own save does not start another translation.
    "write:after": async ({ operation, path, ref }) => {
      const id = ref === "draft" && operation === "writeFile" ? /^docs\/en\/(.+)\.md$/.exec(path)?.[1] : undefined
      if (!id) return
      const [error] = await sendQueue("translate", { id })
      // The commit is already saved. Report the failed enqueue instead of failing the save.
      if (error) console.error(`[translate] Could not enqueue the translation of docs/en/${id}.md:`, error)
    },
  },
})
