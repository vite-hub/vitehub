import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: ["src/durability.ts", "src/h3.ts", "src/index.ts", "src/node.ts", "src/shutdown.ts", "src/internal/drain.ts", "src/internal/grant.ts", "src/internal/runtime-type.ts", "src/internal/execution-budget.ts", "src/internal/test-mode.ts", "src/internal/test-mode-setup.ts"],
  },
});
