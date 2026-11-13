import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      // Editor dependencies must share their ProseMirror and Yjs constructors.
      alwaysBundle: [/^@tiptap\/(?:extension-collaboration|y-tiptap)/, /^@vite-hub\/internal/],
      neverBundle: [/^#vitehub\/realtime\//, "vite", /^prosemirror-(?:model|state|transform|view)$/],
      onlyBundle: false,
    },
    entry: [
      "src/client.ts",
      "src/durability.ts",
      "src/index.ts",
      "src/internal/runtime/unavailable.ts",
      "src/server.ts",
      "src/vite.ts",
      "src/vue.ts",
    ],
  },
})
