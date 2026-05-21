import { defineWorkspace, source } from "@vitehub/workspace"

export default defineWorkspace({
  store: {
    provider: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: {
    docs: source.file({
      workspacePath: "README.md",
      content: "# Workspace example\n",
    }),
  },
})
