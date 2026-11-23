import { defineWorkspace, glob } from "vite-hub/workspace"

export default defineWorkspace({
  sources: {
    docs: glob({ cwd: "docs", include: "**/*.md" }),
  },
})
