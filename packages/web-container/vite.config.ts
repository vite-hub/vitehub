import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["vite", "@webcontainer/api", "@msgpack/msgpack"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/connect.ts",
      "src/env.ts",
      "src/snapshot.ts",
      "src/vite.ts",
    ],
  },
})
