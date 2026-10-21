import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      // Editor dependencies must share their ProseMirror and Yjs constructors.
      alwaysBundle: [/^@tiptap\/(?:extension-collaboration|y-tiptap)/, /^@vite-hub\/internal/],
      neverBundle: ["vite", /^prosemirror-(?:model|state|transform|view)$/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/server.ts",
      "src/vite.ts",
      "src/vue.ts",
    ],
    exports: {
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
