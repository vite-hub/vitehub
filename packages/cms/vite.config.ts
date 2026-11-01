import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["better-auth", /^better-auth\//, "@vite-hub/comments", /^@vite-hub\/comments\//, "@vite-hub/content", /^@vite-hub\/content\//, "@vite-hub/database", /^@vite-hub\/database\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", /^@vite-hub\/workspace\//, "nostics", "vite"],
      onlyBundle: false,
    },
    entry: ["src/access.ts", "src/index.ts", "src/vite.ts"],
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
})
