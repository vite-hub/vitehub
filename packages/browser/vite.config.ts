import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#vitehub\/browser\//, "@cloudflare/playwright", "playwright-core", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/actions.ts",
      "src/index.ts",
      "src/internal/runtime/empty-registry.ts",
      "src/internal/runtime/unconfigured.ts",
      "src/controllers/cdp.ts",
      "src/controllers/playwright.ts",
      "src/providers/cloudflare.ts",
      "src/providers/local.ts",
      "src/vite.ts",
    ],
    exports: { inlinedDependencies: false },
    outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
    publint: true,
  },
})
