import { readdirSync } from "node:fs";
import { defineConfig } from "vite-plus";

import { packDefaults } from "@vite-hub/internal/package-exports";

// One entry for each `src/<name>.ts`: an entry of `@ui-sdk/vue` and the Nuxt module. An app loads only the parts it imports.
const entries = readdirSync(new URL("src/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `src/${file}`);

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: [/^@ui-sdk\//, "@nuxt/kit", "vue"],
      onlyBundle: false,
    },
    entry: entries,
  },
});
