import { defineWorkspace, file } from "@vite-hub/workspace"

export default defineWorkspace({
  store: {
    driver: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: {
    docs: file({
      workspacePath: "README.md",
      content: "# Workspace example\n",
    }),
  },
})
