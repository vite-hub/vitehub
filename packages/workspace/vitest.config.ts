import { fileURLToPath } from "node:url"

import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-workspace-assets-registry": fileURLToPath(new URL("src/runtime/empty-assets-registry.ts", import.meta.url)),
      "#vitehub-workspace-registry": fileURLToPath(new URL("src/runtime/empty-registry.ts", import.meta.url)),
      "@vite-hub/shell/workspace": fileURLToPath(new URL("../shell/src/workspace/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "workspace",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/history.test.ts"],
          typecheck: {
            enabled: true,
            include: ["test/**/*.test-d.ts"],
          },
        },
      },
      {
        extends: true,
        test: {
          name: "history",
          include: ["test/history.test.ts"],
          fileParallelism: false,
          // Miniflare needs the other files to finish before history starts.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
