import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["better-auth", "vite", "#vitehub/auth/definition"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/agent.ts",
      "src/index.ts",
      "src/config.ts",
      "src/discovery.ts",
      "src/runtime/empty-definition.ts",
      "src/server.ts",
      "src/vite.ts",
    ],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
