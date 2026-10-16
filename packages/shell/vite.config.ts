import { defineConfig } from "vite-plus";

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    entry: [
      "src/index.ts",
      "src/providers/cloudflare.ts",
      "src/providers/just-bash.ts",
      { workspace: "src/workspace/index.ts" },
    ],
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
