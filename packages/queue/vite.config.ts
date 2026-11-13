import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "#vitehub/queue/registry", "#vitehub/queue/node-client"],
      onlyBundle: false,
    },
    entry: [
      "src/durability.ts",
      "src/index.ts",
      "src/operations.ts",
      "src/vite.ts",
      "src/internal/runtime/cloudflare-client.ts",
      "src/internal/runtime/cloudflare-vite.ts",
      "src/internal/runtime/local-client.ts",
      "src/internal/runtime/postgres-client.ts",
      "src/internal/runtime/worker-client.ts",
      "src/internal/runtime/state.ts",
      "src/runtime/hosted.ts",
      "src/internal/runtime/vercel-client.ts",
    ],
    exports: {
      // Generated code imports these modules by path. They are not public API.
      exclude: ["operations", "internal/runtime/cloudflare-client", "internal/runtime/cloudflare-vite", "internal/runtime/local-client", "internal/runtime/postgres-client", "internal/runtime/state", "internal/runtime/vercel-client", "internal/runtime/worker-client"],
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
  },
});
