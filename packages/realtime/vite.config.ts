import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: [
    {
      ...packDefaults,
      deps: {
        // Editor dependencies must share their ProseMirror and Yjs constructors.
        alwaysBundle: [/^@tiptap\/(?:extension-collaboration|y-tiptap)/, /^@vite-hub\/internal/],
        neverBundle: [/^#vitehub\/realtime\//, "vite", /^prosemirror-(?:model|state|transform|view)$/],
        onlyBundle: false,
      },
      entry: [
        "src/agent.ts",
        "src/bus.ts",
        "src/client.ts",
        "src/durability.ts",
        "src/index.ts",
        "src/internal/runtime/unavailable.ts",
        "src/server.ts",
        "src/vite.ts",
        "src/vue.ts",
      ],
      exports: {
        ...packDefaults.exports,
        customExports: exports => ({
          ...normalizePackageExports(exports),
          // The prebuilt client below. Same API as `./client`, so it shares its types.
          "./client/browser.js": { types: "./dist/client.d.ts", default: "./dist/client/browser.js" },
        }),
      },
    },
    {
      // `connectRealtimeRoom()` with Yjs bundled in, as one ES module with no imports, for pages without a bundler.
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "client/browser": "src/client.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      target: "es2022",
      tsconfig: "tsconfig.build.json",
    },
  ],
})
