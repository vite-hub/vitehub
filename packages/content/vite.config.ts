import { defineConfig } from "vite-plus"
import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^@vite-hub\/(?:database|runtime|source|workspace)(?:\/|$)/, "comark-content", /^comark-content\//, "vite", "yaml"],
      onlyBundle: false,
    },
    entry: ["src/client.ts", "src/index.ts", "src/presets/cms.ts", "src/vite.ts"],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(Object.entries(exports).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) return [key, value]
            return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }]
          })))
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
