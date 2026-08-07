import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
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
