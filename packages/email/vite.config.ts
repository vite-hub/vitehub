import { defineConfig } from "vite-plus"

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
      "src/drivers/cloudflare-email.ts",
      "src/drivers/resend.ts",
      "src/markdown.ts",
      "src/runtime/empty-definition.ts",
      "src/server.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).filter(([key]) => key !== "./runtime/empty-definition"),
        )
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
