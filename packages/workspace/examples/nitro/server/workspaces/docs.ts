import { defineWorkspace, loader, source } from "@vitehub/workspace"

export default defineWorkspace({
  store: {
    provider: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: [
    source.markdown({
      path: "README.md",
      workspacePath: "README.md",
      content: "# Workspace example\n",
    }),
  ],
  loaders: [
    loader.files({
      include: ["**/*.md"],
    }),
  ],
})
