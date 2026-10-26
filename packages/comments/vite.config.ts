import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: [
    {
      tsconfig: "tsconfig.build.json",
      deps: {
        alwaysBundle: [/^@vite-hub\/internal/],
        onlyBundle: false,
      },
      entry: [
        "src/anchor.ts",
        "src/database.ts",
        "src/index.ts",
        "src/realtime.ts",
        "src/runtime/auth.ts",
        "src/runtime/console.ts",
        "src/runtime/index.ts",
        "src/vite.ts",
      ],
      exports: {
        customExports: normalizePackageExports,
        inlinedDependencies: false,
      },
      outExtensions: () => ({
        dts: ".d.ts",
        js: ".js",
      }),
      publint: true,
    },
    {
      // The overlay that the page tools loader imports. Nitro serves it as a public asset, so it bundles everything.
      deps: { alwaysBundle: [/./], onlyBundle: false },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      dts: false,
      entry: { "overlay/overlay": "src/overlay/index.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      tsconfig: "tsconfig.build.json",
    },
    {
      // The page tools loader at `/_vitehub/page/assets/loader.js`. It has its own build, so it shares no chunk with the overlay.
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "page/loader": "src/overlay/loader.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      tsconfig: "tsconfig.build.json",
    },
  ],
})
