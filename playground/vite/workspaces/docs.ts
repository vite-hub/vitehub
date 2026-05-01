import { defineWorkspace, loader } from "@vitehub/workspace"

export default defineWorkspace({
  name: "docs",
  store: {
    provider: "memory",
  },
  sources: [
    {
      name: "inline-markdown",
      async getKeys() {
        return ["README.md"]
      },
      async getItem() {
        return {
          key: "README.md",
          path: "README.md",
          content: "# Vite playground workspace\n",
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
