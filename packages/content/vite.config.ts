import { defineConfig } from "vite-plus"
import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/, /^comark-(?!content(?:\/|$))/],
      // Keep Vega's Node/browser exports selectable by the consuming host.
      neverBundle: ["vega-canvas", "vega-loader", "@valibot/to-json-schema", "@vite-hub/blob", /^@vite-hub\/blob\//, "@vite-hub/runtime", /^@vite-hub\/runtime\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", "comark-content", /^comark-content\//, "comark", /^comark\//, /^@tiptap\//, "@vite-hub/realtime", /^@vite-hub\/realtime\//, "diff", "drizzle-orm", /^drizzle-orm\//, "vite", "yaml"],
      onlyBundle: false,
    },
    entry: ["src/cli.ts", "src/client.ts", "src/collections.ts", "src/database.ts", "src/editor.ts", "src/index.ts", "src/operations.ts", "src/realtime.ts", "src/runtime/console.ts", "src/vite.ts"],
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
