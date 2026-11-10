import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The Console build writes the app here first. See console.vite.config.ts.
const consoleClientOutDir = resolve(import.meta.dirname, "../console-client/dist/client");

// The `console` page tool is the script that the page tools loader imports on the app's pages when an editor opens the
// Console or Content. It is its own build, after the Console build, so it is one file: in the Console build it shared
// chunks with the Console app, and the browser found each chunk only after the one before it loaded.
export default defineConfig({
  plugins: [{
    // `vite-hub` reads the hashed entry names from this file when it serves the Console page.
    // The Console build wrote `script` and `style`. Reading the file makes it an input of this build, so the task cache
    // runs this build again whenever the Console build changed the names.
    name: "vitehub-console-client-manifest",
    writeBundle(_options, bundle) {
      const manifestFile = resolve(consoleClientOutDir, "../manifest.json");
      const written: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (!written || typeof written !== "object" || !("script" in written) || typeof written.script !== "string" || !("style" in written) || typeof written.style !== "string") {
        throw new TypeError("Run the Console build before the page tool build: manifest.json has no script and style.");
      }
      const { script, style } = written;
      const pageTool = Object.values(bundle).find(file => file.type === "chunk" && file.isEntry)?.fileName;
      if (!pageTool) throw new TypeError("The page tool build wrote no entry script.");
      writeFileSync(manifestFile, `${JSON.stringify({ script, style, pageTool }, null, 2)}\n`);
    },
  }],
  build: {
    emptyOutDir: false,
    outDir: consoleClientOutDir,
    rolldownOptions: {
      input: { "page-tool": resolve(import.meta.dirname, "src/console/page/tool.ts") },
      // Keep the default export of the page tool. An app build drops entry exports by default.
      preserveEntrySignatures: "exports-only",
      output: { entryFileNames: "page-tool-[hash].js" },
    },
  },
});
