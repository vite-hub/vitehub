import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

// One entry for each `src/<name>.ts`: a part that ui-sdk does not have, or the Nuxt module. An app loads only the parts it imports.
const entries = readdirSync(new URL("src/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `src/${file}`);

const webCssImport = '@import "@ui-sdk/core/web.css";';

// The packed `default.css` holds web.css itself, not an import of it. The workspace patches web.css
// (`patches/@ui-sdk__core@*.patch`), and an app that installs the kit gets the unpatched file from npm.
function inlineWebCss() {
  const file = new URL("dist/styles/default.css", import.meta.url);
  const source = readFileSync(file, "utf8");
  if (!source.includes(webCssImport)) throw new Error(`dist/styles/default.css has no ${webCssImport}`);
  const webCss = readFileSync(createRequire(import.meta.url).resolve("@ui-sdk/core/web.css"), "utf8");
  const notice = "/* @ui-sdk/core/web.css (Apache-2.0), with the patch in vite-hub/vitehub patches/. */";
  writeFileSync(file, source.replace(webCssImport, `${notice}\n${webCss.trim()}`));
}

export default defineConfig({
  pack: {
    ...packDefaults,
    // The style family and its tokens ship as plain CSS: `@vite-hub/kit/styles/<file>.css`.
    copy: [{ from: "src/styles", to: "dist" }],
    hooks: { "build:done": inlineWebCss },
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
        "./styles/tokens.css": "./dist/styles/tokens.css",
      }),
    },
  },
});
