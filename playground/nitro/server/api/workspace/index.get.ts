import { defineEventHandler } from "h3"
import { useWorkspace } from "@vitehub/workspace"
import { ensureDocsWorkspace } from "../../utils/workspace"

export default defineEventHandler(async () => {
  ensureDocsWorkspace()
  const workspace = await useWorkspace("docs")
  await workspace.sync()
  return {
    ok: true,
    files: await workspace.list("", { recursive: true }),
    markdown: await workspace.glob("**/*.md"),
    readme: await workspace.readFile("README.md"),
  }
})
