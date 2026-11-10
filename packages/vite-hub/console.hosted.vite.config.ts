import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";
import { consoleDocumentMetadata } from "./src/console/document-metadata";
import { consoleNewProjectPage } from "./src/console/hosted/new-project-page";
import { consoleOAuthClientDocument, consoleOAuthClientPath, resolveConsoleHostedOrigin } from "./src/console/hosted/oauth-client";

// The hosted Console, as a static site with no app around it. It opens the projects that the browser links, so it can
// run on any static host. A static host must answer unknown paths with index.html, so Console routes such as /kv load
// the app. The build also writes 404.html for hosts that use that file, and new.html for /new.
const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const entry = resolve(import.meta.dirname, "src/console/hosted/index.html");
const outDir = resolve(import.meta.dirname, ".vitehub/console-hosted");

const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

// The client ID Metadata Document names the absolute URLs of the Console, so the build needs the origin that serves it.
// Self-hosted Consoles set VITEHUB_CONSOLE_ORIGIN, such as https://console.example.com.
const origin = resolveConsoleHostedOrigin(process.env.VITEHUB_CONSOLE_ORIGIN);

export default defineConfig({
  base: "/",
  resolve: {
    alias: {
      "vite-hub/agent/vue": resolve(import.meta.dirname, "../agent/src/vue.ts"),
      "vite-hub/source/client": resolve(import.meta.dirname, "../source/src/client.ts"),
      "shiki/wasm": resolve(clientRoot, "shiki-wasm.ts"),
      "vue-router": resolve(import.meta.dirname, "node_modules/vue-router"),
    },
    dedupe: ["vue", "vue-router"],
  },
  // `_headers` sets the Content Security Policy and the cache rules on hosts that read it, such as Cloudflare.
  publicDir: resolve(import.meta.dirname, "src/console/hosted/public"),
  plugins: [
    {
      // KaTeX is loaded after the first render. Keep its embedded fonts out of the blocking stylesheet.
      name: "vitehub-console-deferred-katex-styles",
      enforce: "pre",
      transform(code, id) {
        if (/[\\/]ui[\\/]dist[\\/]styles\.css$/.test(id)) return code.replace(katexStyleImport, "");
        // Browsers that run the Console support WOFF2, so omit the larger WOFF and TrueType copies.
        if (/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id)) {
          return code.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
        }
      },
    },
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        // runtime/client/appearance.ts owns the color scheme. Nuxt UI color mode would also write
        // the root class and read the origin-wide `vueuse-color-scheme` key of the host app.
        colorMode: false,
        dts: false,
        // Generate the theme classes of the Nuxt UI components that the Console and `@vite-hub/ui` use, not all 125.
        experimental: { componentDetection: true },
        scanPackages: ["@vite-hub/ui"],
        icon: {
          clientBundle: {
            // Contributed sections declare their icons in owner packages, which the scan does not read.
            icons: [...consoleContributedSectionIcons],
            scan: {
              globInclude: ["src/console/**/*.{js,ts,vue}"],
            },
          },
        },
        ui: consoleAppConfig,
      },
    }),
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
    // Keep font assets portable in self-contained Console bundles.
    assetsInlineLimit: filePath => /\.(?:woff2?|ttf|otf)$/.test(filePath) ? true : undefined,
    emptyOutDir: true,
    outDir,
    rolldownOptions: {
      input: { index: entry },
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        // VueUse holds the color mode writer that Nuxt UI's search keeps behind `colorMode: false`.
        // A separate chunk keeps it out of the entry, so the entry only carries the Console appearance module.
        codeSplitting: { groups: [{ name: "vueuse", test: /[\\/]@vueuse[\\/]core[\\/]/ }] },
        entryFileNames: "assets/console-[hash].js",
      },
    },
  },
});
