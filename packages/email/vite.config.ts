import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

// Generated code imports these modules by path. They are not public API.
const privateEntries = new Set(["./cli", "./operations", "./runtime/empty-definition", "./runtime/outbox"])

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [
        "#vitehub/email/definition",
        "@vite-hub/env",
        "@vite-hub/markdown-template",
        "comark",
        "esbuild",
        "vite",
      ],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/drivers/cloudflare-email.ts",
      "src/drivers/resend.ts",
      "src/markdown.ts",
      "src/operations.ts",
      "src/runtime/console.ts",
      "src/runtime/empty-definition.ts",
      "src/runtime/outbox.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).filter(([key]) => !privateEntries.has(key)),
        ))
      },
      inlinedDependencies: false,
    },
  },
})
