import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["@vite-hub/source", "comark-content", /^comark-content\//],
      onlyBundle: false,
    },
    entry: ["src/client.ts", "src/index.ts"],
    exports: {
      customExports(exports) {
        return {
          ...Object.fromEntries(Object.entries(exports).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) return [key, value]
            return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }]
          })),
        }
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
