import { defineEventHandler, getQuery } from "h3"
import { useWorkspace } from "@vite-hub/workspace"
import { getWorkspaceRuntimeConfig, resetWorkspaceStoreCache } from "@vite-hub/workspace/internal/runtime/state"
import { ensureDocsWorkspace } from "../../utils/workspace"

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const path = typeof query.path === "string" ? query.path : "generated/notes.md"
  resetWorkspaceStoreCache()
  ensureDocsWorkspace()
  const workspace = useWorkspace("docs", { mode: "write" })
  const runtimeConfig = getWorkspaceRuntimeConfig()
  return {
    ok: true,
    provider: runtimeConfig ? runtimeConfig.store.provider : "local",
    path,
    readBack: await workspace.fs.exists(path) ? await workspace.fs.readFile(path) : null,
  }
})
