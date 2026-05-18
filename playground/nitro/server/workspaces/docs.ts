import { defineWorkspace, loader } from "@vitehub/workspace"

export default defineWorkspace({
  sources: {
    inlineMarkdown: {
      mount: "README.md",
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
  },
  loaders: [
    loader.files({
      include: ["**/*.md"],
    }),
  ],
})
