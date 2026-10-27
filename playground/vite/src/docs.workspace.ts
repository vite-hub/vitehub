import { defineWorkspace, file } from "@vite-hub/workspace"
import * as loader from "@vite-hub/workspace/loader"

export default defineWorkspace({
  sources: {
    readme: file({
      workspacePath: "README.md",
      content: "# Vite playground workspace\n",
      mediaType: "text/markdown",
    }),
  },
  loaders: [
    loader.files({
      include: ["**/*.md"],
    }),
  ],
})
