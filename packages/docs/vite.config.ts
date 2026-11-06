import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: [{
    tsconfig: "tsconfig.build.json",
    // Nuxt compiles the Vue app and the theme. Nitro handlers are entries, so they ship as JavaScript.
    copy: [{ from: "runtime/app", to: "dist/runtime" }, { from: "runtime/theme", to: "dist/runtime" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#/, /^@nuxt\//, "nuxt", "vue", /^@vite-hub\//, /^comark/, /^@comark\//, /^shiki/, /^@shikijs\//, "yaml", "nitropack", "h3", "defu", "nuxt-agent-discovery", "nuxt-llms"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/assistant.ts", "src/assistant-worker.ts", "src/link-checker-redirects.ts", "src/navigation.ts", "src/nuxt.ts", "src/server.ts", "src/theme.ts", "src/runtime/server/*.ts"],
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
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  }, {
    // @nuxtjs/mcp-toolkit gives the MCP tools to Nitro by path. Nitro does not compile TypeScript in node_modules, so
    // the tools ship as JavaScript, with every import left for Nitro to resolve.
    clean: false,
    deps: { neverBundle: [/./], onlyBundle: false },
    dts: false,
    entry: { "runtime/mcp/get-page": "runtime/mcp/get-page.ts", "runtime/mcp/list-pages": "runtime/mcp/list-pages.ts" },
    outExtensions: () => ({ js: ".js" }),
    tsconfig: "tsconfig.build.json",
  }],
})
