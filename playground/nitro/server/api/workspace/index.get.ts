import { defineEventHandler } from "h3"
import { useWorkspace } from "@vitehub/workspace"
import { getWorkspaceRuntimeConfig } from "@vitehub/workspace/runtime/state"
import { ensureDocsWorkspace } from "../../utils/workspace"

export default defineEventHandler(async () => {
  ensureDocsWorkspace()
  const workspace = await useWorkspace("docs")
  await workspace.sync()
  const runtimeConfig = getWorkspaceRuntimeConfig()
  const generatedPath = "generated/notes.md"
  return {
    ok: true,
    provider: runtimeConfig ? runtimeConfig.store.provider : "local",
    files: await workspace.list("", { recursive: true }),
    markdown: await workspace.glob("**/*.md"),
    readme: await workspace.readFile("README.md"),
    generated: await workspace.exists(generatedPath) ? await workspace.readFile(generatedPath) : null,
  }
})
