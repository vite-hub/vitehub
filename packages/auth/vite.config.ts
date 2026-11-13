import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [
      { from: "src/host-declarations.d.ts", to: "dist" },
      { from: "src/bun-sqlite.d.ts", to: "dist" },
    ],
    deps: {
      neverBundle: [
        "better-auth",
        "vue",
        "vite",
        "#vitehub/auth/abilities",
        "#vitehub/auth/client",
        "#vitehub/auth/definition",
        "#app",
        "#vitehub/env/server",
        "@vite-hub/auth/server",
        "@vite-hub/auth/internal/server",
        "@vite-hub/auth/runtime/server",
        /^@vite-hub\/env(?:\/|$)/,
        /^@vite-hub\/database(?:\/|$)/,
      ],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [{
      name: "auth-host-declarations",
      generateBundle(_options, bundle) {
        for (const file of ["agent.d.ts", "index.d.ts", "internal/server.d.ts", "nuxt.d.ts", "server.d.ts", "vite.d.ts", "vue.d.ts"]) {
          const chunk = bundle[file]
          if (chunk?.type === "chunk") {
            const reference = file.includes("/") ? "../host-declarations.d.ts" : "./host-declarations.d.ts"
            chunk.code = `/// <reference path="${reference}" />\n${chunk.code}`
          }
        }
      },
    }],
    entry: [
      "src/abilities.ts",
      "src/agent.ts",
      "src/cli.ts",
      "src/runtime/console.ts",
      "src/console.ts",
      "src/console-runtime.ts",
      "src/database.ts",
      "src/mcp.ts",
      "src/index.ts",
      "src/internal/server.ts",
      "src/runtime/empty-abilities.ts",
      "src/runtime/empty-client.ts",
      "src/runtime/empty-definition.ts",
      "src/runtime/nuxt.ts",
      "src/runtime/vue-nuxt.ts",
      "src/runtime/server.ts",
      "src/server.ts",
      "src/nuxt.ts",
      "src/presets.ts",
      "src/schema.ts",
      "src/vue.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).filter(([key]) => !["./runtime/empty-abilities", "./runtime/empty-client", "./runtime/empty-definition", "./runtime/nuxt", "./runtime/vue-nuxt"].includes(key)),
        ))
      },
      inlinedDependencies: false,
    },
  },
})
