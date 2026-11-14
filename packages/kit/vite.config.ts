import { readdirSync } from "node:fs";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

// One entry for each `src/<name>.ts`: a part that ui-sdk does not have, or the Nuxt module. An app loads only the parts it imports.
const entries = readdirSync(new URL("src/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `src/${file}`);

export default defineConfig({
  pack: {
    ...packDefaults,
    // The style family and its tokens ship as plain CSS: `@vite-hub/kit/styles/<file>.css`.
    copy: [{ from: "src/styles", to: "dist" }],
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
        "./styles/tokens.css": "./dist/styles/tokens.css",
      }),
    },
  },
});
