import { renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";

import consoleConfig from "./console.hosted.vite.config";
import { consoleDocumentMetadata } from "./src/console/document-metadata";

// The page of the Console app (`@vite-hub/console`): the hosted page in `account` mode. People sign in to the Console,
// and the Console server forwards the calls of their team's projects. The Console app serves this folder and answers
// Console routes such as /kv with index.html, with its own headers. account.html has the first paint of each view.
const entry = resolve(import.meta.dirname, "src/console/hosted/account.html");
const outDir = resolve(import.meta.dirname, ".vitehub/console-account");

const base: UserConfig = consoleConfig;

export default defineConfig({
  ...base,
  base: "/",
  publicDir: false,
  plugins: [
    ...(base.plugins ?? []).filter(plugin => !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "vitehub-console-hosted")),
    {
      name: "vitehub-console-account",
      transformIndexHtml: html => html.replace("<!--vitehub-console-metadata-->", consoleDocumentMetadata.trim()),
      closeBundle() {
        // Vite writes the page at its path below the package, src/console/hosted, and the app serves it at the root.
        renameSync(resolve(outDir, "src/console/hosted/account.html"), resolve(outDir, "index.html"));
        rmSync(resolve(outDir, "src"), { force: true, recursive: true });
      },
    },
  ],
  build: {
    ...base.build,
    outDir,
    rolldownOptions: {
      input: { index: entry },
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        codeSplitting: { groups: [{ name: "vueuse", test: /[\\/]@vueuse[\\/]core[\\/]/ }] },
        entryFileNames: "assets/console-[hash].js",
      },
    },
  },
});
