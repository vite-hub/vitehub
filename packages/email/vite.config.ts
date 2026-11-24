import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

const privateEntries = new Set(["./cli", "./operations", "./runtime/empty-definition", "./runtime/outbox", "./runtime/vue-render"])

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
        "nodemailer",
        "vite",
        "vue",
      ],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/log.ts",
      "src/drivers/resend.ts",
      "src/drivers/smtp.ts",
      "src/markdown.ts",
      "src/operations.ts",
      "src/runtime/console.ts",
      "src/runtime/empty-definition.ts",
      "src/runtime/outbox.ts",
      "src/runtime/vue-render.ts",
      "src/test.ts",
      "src/vite.ts",
      "src/vue.ts",
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
