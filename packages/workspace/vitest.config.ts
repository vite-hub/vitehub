import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-workspace-assets-registry": new URL("src/runtime/empty-assets-registry.ts", import.meta.url).pathname,
      "#vitehub-workspace-registry": new URL("src/runtime/empty-registry.ts", import.meta.url).pathname,
      "@vite-hub/shell/workspace": new URL("../shell/src/workspace/index.ts", import.meta.url).pathname,
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
