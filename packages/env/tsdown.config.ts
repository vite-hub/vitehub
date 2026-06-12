import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" },
  ],
  deps: {
    alwaysBundle: [/^@vite-hub\/internal/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/presets.ts",
    "src/schema.ts",
    "src/server.ts",
    "src/secret.ts",
    "src/virtual.ts",
    "src/vite.ts",
  ],
  exports: {
    customExports(exports) {
      return Object.fromEntries(Object.entries(exports).map(([key, value]) => {
        if (typeof value !== "string" || !value.endsWith(".js")) {
          return [key, value]
        }
        return [key, {
          types: value.replace(/\.js$/, ".d.ts"),
          import: value,
        }]
      }))
    },
    inlinedDependencies: false,
  },
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
