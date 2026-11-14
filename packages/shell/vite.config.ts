import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    entry: [
      "src/index.ts",
      "src/providers/just-bash.ts",
      { workspace: "src/workspace/index.ts" },
    ],
  },
});
