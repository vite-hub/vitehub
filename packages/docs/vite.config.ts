import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: [{
    ...packDefaults,
    // Nuxt compiles the Vue app and the theme. Nitro handlers are entries, so they ship as JavaScript.
    copy: [{ from: "runtime/app", to: "dist/runtime" }, { from: "runtime/theme", to: "dist/runtime" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#/, /^@nuxt\//, "nuxt", "vue", /^@vite-hub\//, /^comark/, /^@comark\//, /^shiki/, /^@shikijs\//, "yaml", "h3", /^nitro(\/|$)/, "defu", "nuxt-agent-discovery"],
      onlyBundle: false,
    },
    // virtual.d.ts types the Nitro virtual modules for this package only. Shipped, it would add a `#imports` overload to the app.
    entry: ["src/index.ts", "src/assistant.ts", "src/assistant-worker.ts", "src/link-checker-redirects.ts", "src/navigation.ts", "src/nuxt.ts", "src/server.ts", "src/theme.ts", "src/runtime/server/*.ts", "!src/runtime/server/*.d.ts"],
    exports: {
      customExports(exports) {
        // The Nuxt module loads the runtime handlers, the theme, and its link checker helper by path. They are not public entries.
        const entries = normalizePackageExports(Object.fromEntries(Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/") && key !== "./theme" && key !== "./assistant-worker" && key !== "./link-checker-redirects")))
        // A Worker cannot start Codex, so a Worker build resolves the assistant with a model-backed Driver.
        const worker = "./dist/assistant-worker.js"
        return { ...entries, "./assistant": { types: "./dist/assistant.d.ts", workerd: worker, worker, import: "./dist/assistant.js", default: "./dist/assistant.js" } }
      },
      inlinedDependencies: false,
    },
  }],
})
