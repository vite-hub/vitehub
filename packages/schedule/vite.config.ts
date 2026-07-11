import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/registry-module.d.ts", to: "dist" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild"],
      onlyBundle: false,
    },
    entry: [
      "src/definition.ts",
      "src/index.ts",
      "src/nuxt.ts",
      "src/runtime.ts",
      "src/runtime/driver.ts",
      "src/runtime/state.ts",
      "src/runtime/static.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(Object.entries(exports).filter(([key]) => key !== "./definition"));
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
