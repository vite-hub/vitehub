import { defineWorkspace } from "@vite-hub/workspace"
import * as loader from "@vite-hub/workspace/loader"

export default defineWorkspace({
  sources: [
    {
      mount: "README.md",
      name: "inline-markdown",
      async getKeys() {
        return [""]
      },
      async getItem() {
        return {
          key: "",
          path: "",
          content: "# Nitro playground workspace\n",
          mediaType: "text/markdown",
        }
      },
    },
  ],
  loaders: [
    loader.files({
      include: ["**/*.md"],
    }),
  ],
})
