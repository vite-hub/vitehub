import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["vite"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/setup/index.ts"],
  },
});
