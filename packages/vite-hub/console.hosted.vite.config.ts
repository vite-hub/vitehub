import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";

import consoleConfig from "./console.vite.config";
import { consoleDocumentMetadata } from "./src/console/document-metadata";
import { consoleNewProjectPage } from "./src/console/hosted/new-project-page";
import { consoleOAuthClientDocument, consoleOAuthClientPath, resolveConsoleHostedOrigin } from "./src/console/hosted/oauth-client";

// The hosted Console: the same app as the Console that apps serve, as a static site with no app around it. It opens the
// projects that the browser links, so it can run on any static host. A static host must answer unknown paths with
// index.html, so Console routes such as /kv load the app. The build also writes 404.html for hosts that use that file, and new.html for /new.
const entry = resolve(import.meta.dirname, "src/console/hosted/index.html");
const outDir = resolve(import.meta.dirname, ".vitehub/console-hosted");

// The client ID Metadata Document names the absolute URLs of the Console, so the build needs the origin that serves it.
// Self-hosted Consoles set VITEHUB_CONSOLE_ORIGIN, such as https://console.example.com.
const origin = resolveConsoleHostedOrigin(process.env.VITEHUB_CONSOLE_ORIGIN);

const base: UserConfig = consoleConfig;

export default defineConfig({
  ...base,
  base: "/",
  // `_headers` sets the Content Security Policy and the cache rules on hosts that read it, such as Cloudflare.
  publicDir: resolve(import.meta.dirname, "src/console/hosted/public"),
  plugins: [
    ...(base.plugins ?? []),
    {
      name: "vitehub-console-hosted",
      transformIndexHtml: html => html.replace("<!--vitehub-console-metadata-->", consoleDocumentMetadata.trim()),
      generateBundle() {
        // Apps read this file to know the Console as an OAuth client. Its URL is the client_id.
        this.emitFile({ type: "asset", fileName: consoleOAuthClientPath.slice(1), source: `${JSON.stringify(consoleOAuthClientDocument(origin), null, 2)}\n` });
      },
      closeBundle() {
        // Vite writes the page at its path below the package, src/console/hosted, and the site serves it at the root.
        renameSync(resolve(outDir, "src/console/hosted/index.html"), resolve(outDir, "index.html"));
        rmSync(resolve(outDir, "src"), { force: true, recursive: true });
        copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
        // Static hosts such as Cloudflare and Netlify serve new.html for /new.
        writeFileSync(resolve(outDir, "new.html"), consoleNewProjectPage(readFileSync(resolve(outDir, "index.html"), "utf8")));
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
