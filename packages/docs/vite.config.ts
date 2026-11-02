import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    // Nuxt compiles the Vue app and the theme. Nitro handlers are entries, so they ship as JavaScript.
    copy: [{ from: "runtime/app", to: "dist/runtime" }, { from: "runtime/theme", to: "dist/runtime" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#/, /^@nuxt\//, "nuxt", "vue", /^@vite-hub\//, /^comark/, "shiki", /^@shikijs\//, "valibot", "yaml", "nitropack", "h3"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/assistant.ts", "src/nuxt.ts", "src/server.ts", "src/runtime/server/*.ts"],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/"))))
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
