import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["@vite-hub/blob", /^@vite-hub\/blob\//, "@vite-hub/runtime", /^@vite-hub\/runtime\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", "comark-content", /^comark-content\//, "drizzle-orm", /^drizzle-orm\//, "yaml"],
      onlyBundle: false,
    },
    entry: ["src/client.ts", "src/database.ts", "src/index.ts", "src/runtime/console.ts", "src/vite.ts"],
    exports: {
      customExports(exports) {
        return Object.fromEntries(Object.entries(exports).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) return [key, value]
            return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }]
          }))
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
