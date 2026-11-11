import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { bundledLanguagesInfo } from "shiki/langs";
import { defineConfig } from "vite";

import type { Plugin } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";
import { consoleDocumentMetadata } from "./src/console/document-metadata";

// The page of the Console app (`@vite-hub/console`) in `account` mode. People sign in to the Console, and the Console
// server signs and forwards the calls of their team's projects. The Console app serves this folder and answers Console
// routes such as /kv with index.html, with its own headers. account.html has the first paint of each view.
const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const entry = resolve(import.meta.dirname, "src/console/hosted/account.html");
const outDir = resolve(import.meta.dirname, ".vitehub/console-account");

const consoleShikiId = "\0vitehub-console-shiki";

/**
 * The code views of `@vite-hub/ui` import the full Shiki bundle: every grammar and theme, 9 MB of chunks in the
 * Console build. The Console resolves `shiki` to a bundle with the languages it highlights. The other languages keep
 * their names and render as plain text, so a diff of a Python file still opens.
 */
function consoleShiki(): Plugin {
  const aliases = Object.fromEntries(bundledLanguagesInfo.flatMap(info => (info.aliases ?? []).map(alias => [alias, info.id])));
  const names = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])]);
  const languages = resolve(clientRoot, "highlight-languages.ts");
  return {
    name: "vitehub-console-shiki",
    enforce: "pre",
    resolveId: { filter: { id: /^shiki$/ }, handler: () => consoleShikiId },
    load: {
      filter: { id: /^\0vitehub-console-shiki$/ },
      handler: () => `import { createBundledHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { consoleHighlightLanguages } from ${JSON.stringify(languages)};
export * from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";
const aliases = ${JSON.stringify(aliases)};
const plain = name => async () => ({ default: [{ name, scopeName: \`text.plain.\${name}\`, patterns: [] }] });
export const bundledLanguages = Object.fromEntries(${JSON.stringify(names)}.map((name) => {
  const id = aliases[name] ?? name;
  return [name, Object.hasOwn(consoleHighlightLanguages, id) ? consoleHighlightLanguages[id] : plain(name)];
}));
export const createHighlighter = createBundledHighlighter({ engine: createJavaScriptRegexEngine, langs: bundledLanguages, themes: {} });
`,
    },
  };
}

const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

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
  publicDir: false,
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
    consoleShiki(),
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
