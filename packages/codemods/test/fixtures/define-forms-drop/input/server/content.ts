import { defineContent } from "vite-hub/content"
import { files } from "vite-hub/source/files"

/**
 * The docs at /docs, written in Markdown under content/docs. Vite bundles the files into the server at build time,
 * so every host serves them, Workers included, with no file system at runtime.
 */
export const content = defineContent({
  sources: {
    docs: files(
      import.meta.glob<string>("../content/docs/**/*.md", { query: "?raw", import: "default", eager: true }),
      { base: "../content/docs" },
    ),
  },
})
