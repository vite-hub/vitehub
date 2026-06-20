import { defineWorkspace, file } from "@vite-hub/workspace"

export default defineWorkspace({
  store: {
    provider: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: {
    docs: file({
      workspacePath: "README.md",
      content: "# Workspace example\n",
    }),
  },
})
