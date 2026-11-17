import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

import { inlineWebCss, scopeStyles } from "./scripts/styles.ts";

// One entry for each `src/<name>.ts`: a part that ui-sdk does not have, or the Nuxt module. An app loads only the parts it imports.
const entries = readdirSync(new URL("src/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `src/${file}`);

export default defineConfig({
  pack: {
    ...packDefaults,
    // Emit the style family before publint validates the package exports.
    plugins: [{
      name: "kit-styles",
      generateBundle() {
        const readStyle = (name: string) => readFileSync(new URL(`src/styles/${name}`, import.meta.url), "utf8");
        const webCss = readFileSync(createRequire(import.meta.url).resolve("@ui-sdk/core/web.css"), "utf8");
        const family = inlineWebCss(readStyle("default.css"), webCss);
        for (const [name, source] of [
          ["default.css", family],
          ["default.scoped.css", scopeStyles(family)],
          ["tailwind.css", readStyle("tailwind.css")],
          ["tokens.css", readStyle("tokens.css")],
          ["tailwind.css", readStyle("tailwind.css")],
        ]) {
          this.emitFile({ type: "asset", fileName: `styles/${name}`, source });
        }
      },
    }],
    deps: {
      neverBundle: [/^@ui-sdk\//, "@nuxt/kit", "vue"],
      onlyBundle: false,
    },
    entry: entries,
    exports: {
      ...packDefaults.exports,
      customExports: (exports) => ({
        ...packDefaults.exports.customExports(exports),
        "./styles/default.css": "./dist/styles/default.css",
        "./styles/tailwind.css": "./dist/styles/tailwind.css",
        "./styles/default.scoped.css": "./dist/styles/default.scoped.css",
        "./styles/tokens.css": "./dist/styles/tokens.css",
      }),
    },
  },
});
