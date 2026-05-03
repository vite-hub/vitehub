import { defineEventHandler, getQuery } from "h3"
import { useWorkspace } from "@vitehub/workspace"
import { getWorkspaceRuntimeConfig, resetWorkspaceStoreCache } from "@vitehub/workspace/runtime/state"
import { ensureDocsWorkspace } from "../../utils/workspace"

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const path = typeof query.path === "string" ? query.path : "generated/notes.md"
  resetWorkspaceStoreCache()
  ensureDocsWorkspace()
  const workspace = await useWorkspace("docs")
  const runtimeConfig = getWorkspaceRuntimeConfig()
  return {
    ok: true,
    provider: runtimeConfig ? runtimeConfig.store.provider : "local",
    path,
    readBack: await workspace.readFile(path),
  }
})
