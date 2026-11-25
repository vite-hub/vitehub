import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: ["src/durability.ts", "src/internal/h3.ts", "src/index.ts", "src/operations.ts", "src/internal/node.ts", "src/internal/public-url.ts", "src/internal/shutdown.ts", "src/internal/drain.ts", "src/internal/grant.ts", "src/internal/run-failed.ts", "src/internal/run-scope.ts", "src/internal/runtime-type.ts", "src/internal/execution-budget.ts", "src/internal/test-mode.ts", "src/internal/test-mode-setup.ts", "src/internal/console.ts", "src/internal/detect-host.ts", "src/internal/context.ts", "src/internal/error-diagnostics.ts", "src/internal/response.ts", "src/internal/trace.ts"],
  },
});
