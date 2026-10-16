import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
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
      "src/runtime/console.ts",
      "src/runtime/empty-definition.ts",
      "src/runtime/outbox.ts",
      "src/server.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).filter(([key]) => key !== "./cli" && key !== "./runtime/empty-definition" && key !== "./runtime/outbox"),
        ))
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
