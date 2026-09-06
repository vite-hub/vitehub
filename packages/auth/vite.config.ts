import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/host-declarations.d.ts", to: "dist" }],
    deps: {
      neverBundle: [
        "better-auth",
        "vue",
        "vite",
        "#vitehub/auth/definition",
        "#vitehub/env/server",
        "@vite-hub/auth/server",
        /^@vite-hub\/env(?:\/|$)/,
      ],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [{
      name: "auth-host-declarations",
      generateBundle(_options, bundle) {
        for (const file of ["agent.d.ts", "index.d.ts", "nuxt.d.ts", "server.d.ts", "vite.d.ts", "vue.d.ts"]) {
          const chunk = bundle[file]
          if (chunk?.type === "chunk") {
            chunk.code = `/// <reference path="./host-declarations.d.ts" />\n${chunk.code}`
          }
        }
      },
    }],
    entry: [
      "src/agent.ts",
      "src/index.ts",
      "src/runtime/empty-definition.ts",
      "src/runtime/nuxt.ts",
      "src/server.ts",
      "src/nuxt.ts",
      "src/vue.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).filter(([key]) => !["./runtime/empty-definition", "./runtime/nuxt"].includes(key)),
        )
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
