import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

import { inlineWebCss, scopeStyles } from "./scripts/styles.ts";

// One entry for each `src/<name>.ts`: a part that ui-sdk does not have, or the Nuxt module. An app loads only the parts it imports.
const entries = readdirSync(new URL("src/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `src/${file}`);

// The packed `default.css` holds the patched web.css itself, and `default.scoped.css` is the same family under `.ui-sdk`.
function writeStyles() {
  const file = new URL("dist/styles/default.css", import.meta.url);
  const webCss = readFileSync(createRequire(import.meta.url).resolve("@ui-sdk/core/web.css"), "utf8");
  const family = inlineWebCss(readFileSync(file, "utf8"), webCss);
  writeFileSync(file, family);
  writeFileSync(new URL("dist/styles/default.scoped.css", import.meta.url), scopeStyles(family));
}

export default defineConfig({
  pack: {
    ...packDefaults,
    // The style family and its tokens ship as plain CSS: `@vite-hub/kit/styles/<file>.css`.
    copy: [{ from: "src/styles", to: "dist" }],
    hooks: { "build:done": writeStyles },
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
