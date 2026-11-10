import { defineConfig } from "vite-plus"
import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      // Let the consuming host resolve and deduplicate the Markdown preset.
      neverBundle: ["comark-ui", /^comark-ui\//, "@valibot/to-json-schema", "@vite-hub/blob", /^@vite-hub\/blob\//, "@vite-hub/runtime", /^@vite-hub\/runtime\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", "comark-content", /^comark-content\//, "comark", /^comark\//, /^@tiptap\//, "@vite-hub/realtime", /^@vite-hub\/realtime\//, "@sqlite.org/sqlite-wasm", /^@sqlite\.org\/sqlite-wasm\//, "diff", "drizzle-orm", /^drizzle-orm\//, "vite", "yaml"],
      onlyBundle: false,
    },
    entry: ["src/cli.ts", "src/client.ts", "src/collections.ts", "src/database.ts", "src/editor.ts", "src/index.ts", "src/operations.ts", "src/realtime.ts", "src/runtime/console.ts", "src/sqlite.ts", "src/sqlite-workerd.ts", "src/vite.ts"],
    exports: {
      // Generated code imports these modules by path. They are not public API.
      exclude: ["operations", "runtime/console"],
      customExports(exports) {
        const { "./sqlite-workerd": _workerd, ...entries } = exports
        return normalizePackageExports(Object.fromEntries(Object.entries(entries).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) return [key, value]
            // Cloudflare Workers have no working Node SQLite, so `./sqlite` resolves to SQLite WASM there.
            if (key === "./sqlite") return [key, { types: "./dist/sqlite.d.ts", workerd: "./dist/sqlite-workerd.js", import: value }]
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
