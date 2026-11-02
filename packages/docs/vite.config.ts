import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    // Nuxt compiles the Vue app, the MCP tools, and the theme. Nitro handlers are entries, so they ship as JavaScript.
    copy: [{ from: "runtime/app", to: "dist/runtime" }, { from: "runtime/mcp", to: "dist/runtime" }, { from: "runtime/theme", to: "dist/runtime" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#/, /^@nuxt\//, "nuxt", "vue", /^@vite-hub\//, /^comark/, /^@comark\//, /^shiki/, /^@shikijs\//, "valibot", "yaml", "nitropack", "h3", "defu", "nuxt-agent-discovery", "nuxt-llms"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/assistant.ts", "src/navigation.ts", "src/nuxt.ts", "src/server.ts", "src/theme.ts", "src/runtime/server/*.ts"],
    exports: {
      customExports(exports) {
        // The Nuxt module loads the runtime handlers and the theme by path. They are not public entries.
        return normalizePackageExports(Object.fromEntries(Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/") && key !== "./theme")))
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
