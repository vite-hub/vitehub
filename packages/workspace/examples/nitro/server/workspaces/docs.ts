import { defineWorkspace, source } from "@vitehub/workspace"

export default defineWorkspace({
  store: {
    provider: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: [
    source.file({
      path: "README.md",
      workspacePath: "README.md",
      content: "# Workspace example\n",
    }),
  ],
})
