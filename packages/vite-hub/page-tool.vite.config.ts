import { resolve } from "node:path";
import { defineConfig } from "vite";

// The `console` page tool is the script that the page tools loader imports on the app's pages when an editor opens the
// Console or Content. It is its own build, after the Console build, so it is one file: in the Console build it shared
// chunks with the Console app, and the browser found each chunk only after the one before it loaded.
export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: resolve(import.meta.dirname, ".vitehub/console"),
    rolldownOptions: {
      input: { "page-tool": resolve(import.meta.dirname, "src/console/page/tool.ts") },
      // Keep the default export of the page tool. An app build drops entry exports by default.
      preserveEntrySignatures: "exports-only",
      output: { entryFileNames: "page-tool-[hash].js" },
    },
  },
});
