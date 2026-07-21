import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["@cloudflare/playwright", "playwright-core", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
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
