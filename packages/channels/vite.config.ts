import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["#vitehub/channels/registry", "#vitehub/channels/runtime", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/empty-runtime.ts",
      "src/server.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).filter(([key]) => !["./runtime/empty-registry", "./runtime/empty-runtime"].includes(key)),
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
