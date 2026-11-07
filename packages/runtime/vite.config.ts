import { defineConfig } from "vite-plus";

import { normalizePackageExports } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: ["src/h3.ts", "src/index.ts", "src/node.ts", "src/shutdown.ts", "src/internal/drain.ts", "src/internal/grant.ts", "src/internal/runtime-type.ts", "src/internal/execution-budget.ts"],
    exports: {
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
