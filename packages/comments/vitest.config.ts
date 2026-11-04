import { defineConfig } from "vitest/config"

import { overlayAliases, standaloneUI } from "./overlay.aliases.ts"

export default defineConfig({
  // The overlay tests run the comment parts from the `@vite-hub/ui` sources, as the overlay build does.
  plugins: [standaloneUI()],
  resolve: { alias: overlayAliases, dedupe: ["vue"] },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
