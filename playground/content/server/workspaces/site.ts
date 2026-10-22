import { blob } from "vite-hub/blob"
import { defineWorkspace } from "vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore } from "vite-hub/workspace/blob-database"

import contentDatabase from "../databases/content/config"

export default defineWorkspace({
  store: createBlobDatabaseWorkspaceStore({
    blob: blob.store("default"),
    database: contentDatabase,
    workspace: "site",
  }),
})
