import { defineConfig } from "vite-plus";

import { normalizePackageExports } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: ["src/drain.ts", "src/h3.ts", "src/index.ts", "src/node.ts", "src/internal/grant.ts", "src/internal/runtime-type.ts"],
    exports: {
      bin: {
        "vitehub-drain": "src/drain.ts",
      },
      customExports(exports) {
        delete exports["./drain"]
        return normalizePackageExports(exports)
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
