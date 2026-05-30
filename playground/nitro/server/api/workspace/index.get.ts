import { defineEventHandler } from "h3"
import { useWorkspace } from "@vite-hub/workspace"
import { getWorkspaceRuntimeConfig } from "@vite-hub/workspace/internal/runtime/state"
import { ensureDocsWorkspace } from "../../utils/workspace"

export default defineEventHandler(async () => {
  ensureDocsWorkspace()
  const workspace = useWorkspace("docs", { mode: "write" })
  const runtimeConfig = getWorkspaceRuntimeConfig()
  const generatedPath = "generated/notes.md"
  return {
    ok: true,
    provider: runtimeConfig ? runtimeConfig.store.provider : "local",
    files: await workspace.fs.list("", { recursive: true }),
    markdown: await workspace.fs.glob("**/*.md"),
    readme: await workspace.fs.readFile("README.md"),
    generated: await workspace.fs.exists(generatedPath) ? await workspace.fs.readFile(generatedPath) : null,
  }
})
