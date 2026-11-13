import { readdirSync } from "node:fs";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

// One entry for each `src/<name>.ts`: an entry of `@ui-sdk/vue`, the Nuxt module, and the catalog. An app loads only the
// parts it imports. The catalog's Vue renderer has its own entry, so a server that checks specs does not load Vue.
const entries = [
  ...readdirSync(new URL("src/", import.meta.url))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/${file}`),
  "src/catalog/vue.ts",
];

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: [/^@ui-sdk\//, /^@json-render\//, "@nuxt/kit", "vue", "zod"],
      // The catalog's diagnostics ship inside the package, so its runtime dependencies stay `@ui-sdk/*`.
      alwaysBundle: ["nostics"],
      onlyBundle: false,
    },
    entry: entries,
  },
});
