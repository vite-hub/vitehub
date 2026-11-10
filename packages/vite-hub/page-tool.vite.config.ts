import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The Console build writes the app here first. See console.vite.config.ts.
const consoleClientOutDir = resolve(import.meta.dirname, "../console-client/dist/client");

/** The one hashed file in the Console client output whose name starts with `prefix` and ends with `extension`. */
function consoleClientAsset(prefix: "console-" | "page-tool-", extension: ".css" | ".js"): string {
  const matches = readdirSync(consoleClientOutDir).filter(file => file.startsWith(prefix) && file.endsWith(extension));
  if (matches.length !== 1) throw new TypeError(`Expected one hashed Console ${prefix}*${extension} asset, found ${matches.length}.`);
  return matches[0]!;
}

// The `console` page tool is the script that the page tools loader imports on the app's pages when an editor opens the
// Console or Content. It is its own build, after the Console build, so it is one file: in the Console build it shared
// chunks with the Console app, and the browser found each chunk only after the one before it loaded.
export default defineConfig({
  plugins: [{
    // `vite-hub` reads the hashed entry names from this file when it serves the Console page.
    name: "vitehub-console-client-manifest",
    closeBundle() {
      const manifest = {
        script: consoleClientAsset("console-", ".js"),
        style: consoleClientAsset("console-", ".css"),
        pageTool: consoleClientAsset("page-tool-", ".js"),
      };
      writeFileSync(resolve(consoleClientOutDir, "../manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
