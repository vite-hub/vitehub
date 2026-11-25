import { defineConfig } from "vite-plus"

import { browserTarget, normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

import { motionCore } from "./overlay.aliases.ts"

export default defineConfig({
  pack: [
    {
      ...packDefaults,
      deps: {
        alwaysBundle: [/^@vite-hub\/internal/],
        neverBundle: ["nostics"],
        onlyBundle: false,
      },
      entry: [
        "src/anchor.ts",
        "src/client.ts",
        "src/database/postgres.ts",
        "src/operations.ts",
        "src/rpc.ts",
        "src/server.ts",
        "src/testing.ts",
        "src/database.ts",
        "src/index.ts",
        "src/realtime.ts",
        "src/runtime/auth.ts",
        "src/runtime/client-request-plugin.ts",
        "src/runtime/connect.ts",
        "src/runtime/connect/node.ts",
        "src/runtime/console.ts",
        "src/runtime/index.ts",
        "src/vite.ts",
      ],
      exports: {
        // Generated code imports these modules by path. They are not public API.
        exclude: ["operations", "runtime/client-request-plugin", "runtime/console"],
        customExports: normalizePackageExports,
        inlinedDependencies: false,
      },
    },
    {
      // The page tools loader at `/_vitehub/page/assets/loader.js`. It has its own build, so it shares no chunk with the overlay.
      alias: { "@vite-hub/ui/motion/core": motionCore },
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "page/loader": "src/overlay/loader.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      target: browserTarget,
      tsconfig: "tsconfig.build.json",
    },
  ],
})
