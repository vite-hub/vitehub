import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["#vitehub/connections/registry", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/agent.ts",
      "src/google.ts",
      "src/http.ts",
      "src/runtime/empty-registry.ts",
      "src/server.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).filter(([key]) => key !== "./runtime/empty-registry"),
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
