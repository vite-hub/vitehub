import { defineConfig } from "vite-plus"
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      // Inline the pure Blob field schemas so Content does not import the server root when Blob is disabled.
      alwaysBundle: [/^@vite-hub\/internal/, /^@vite-hub\/blob$/],
      // Let the consuming host resolve and deduplicate the Markdown preset.
      neverBundle: ["comark-ui", /^comark-ui\//, "@valibot/to-json-schema", /^@vite-hub\/blob\//, "@vite-hub/runtime", /^@vite-hub\/runtime\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", "comark-content", /^comark-content\//, "comark", /^comark\//, /^@tiptap\//, "@vite-hub/realtime", /^@vite-hub\/realtime\//, "@sqlite.org/sqlite-wasm", /^@sqlite\.org\/sqlite-wasm\//, "diff", "drizzle-orm", /^drizzle-orm\//, "vite", "yaml"],
      onlyBundle: false,
    },
    entry: {
      "cli": "src/cli.ts",
      "client": "src/client.ts",
      "collections": "src/collections.ts",
      "database": "src/database.ts",
      "editor": "src/editor.ts",
      "index": "src/index.ts",
      // Markdown negotiation without the Content runtime, for the generated Markdown middleware.
      "markdown": "src/markdown-entry.ts",
      "operations": "src/operations.ts",
      // The preview API without the Content runtime, for the generated preview plugin.
      "preview": "src/preview-entry.ts",
      "realtime": "src/realtime.ts",
      "runtime/console": "src/runtime/console.ts",
      "sqlite": "src/sqlite.ts",
      "sqlite-workerd": "src/sqlite-workerd.ts",
      "vite": "src/vite.ts",
    },
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
  },
})
