import { copyFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type PluginOption, type UserConfig } from "vite";

import consoleConfig from "./console.vite.config";
import { consoleDocumentMetadata } from "./src/console/document-metadata";

// The hosted Console: the same app as the Console that apps serve, as a static site with no app around it. It opens the
// projects that the browser links, so it can run on any static host. A static host must answer unknown paths with
// index.html, so Console routes such as /kv load the app. The build also writes 404.html for hosts that use that file.
const entry = resolve(import.meta.dirname, "src/console/hosted/index.html");
const outDir = resolve(import.meta.dirname, ".vitehub/console-hosted");

const base: UserConfig = consoleConfig;
const plugins: PluginOption[] = (base.plugins ?? []).flat().filter(plugin =>
  // The app Console build publishes the skills of `npx skills add <app>/_vitehub`. A static Console has no app.
  !(plugin instanceof Object && "name" in plugin && plugin.name === "vitehub-console-skills"));

export default defineConfig({
  ...base,
  base: "/",
  // `_headers` sets the Content Security Policy and the cache rules on hosts that read it, such as Cloudflare.
  publicDir: resolve(import.meta.dirname, "src/console/hosted/public"),
  plugins: [
    ...plugins,
    {
      name: "vitehub-console-hosted",
      transformIndexHtml: html => html.replace("<!--vitehub-console-metadata-->", consoleDocumentMetadata.trim()),
      closeBundle() {
        // Vite writes the page at its path below the package, src/console/hosted, and the site serves it at the root.
        renameSync(resolve(outDir, "src/console/hosted/index.html"), resolve(outDir, "index.html"));
        rmSync(resolve(outDir, "src"), { force: true, recursive: true });
        copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
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
