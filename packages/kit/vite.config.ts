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
function family(): string {
  const webCss = readFileSync(createRequire(import.meta.url).resolve("@ui-sdk/core/web.css"), "utf8");
  return inlineWebCss(readFileSync(new URL("src/styles/default.css", import.meta.url), "utf8"), webCss);
}

// The pack checks the exports with publint before `build:done`, so the scoped file, which is not in `src/styles`, is an
// asset of the build. `default.css` is copied from `src/styles` first and gets web.css in `build:done`.
const scopedStyles = {
  name: "vitehub-kit-scoped-styles",
  generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: string }) => string }) {
    this.emitFile({ type: "asset", fileName: "styles/default.scoped.css", source: scopeStyles(family()) });
  },
};

export default defineConfig({
  pack: {
    ...packDefaults,
    // The style family and its tokens ship as plain CSS: `@vite-hub/kit/styles/<file>.css`.
    copy: [{ from: "src/styles", to: "dist" }],
    hooks: { "build:done": () => writeFileSync(new URL("dist/styles/default.css", import.meta.url), family()) },
    plugins: [scopedStyles],
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
