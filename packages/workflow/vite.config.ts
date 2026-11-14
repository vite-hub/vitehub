import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"
import packageManifest from "./package.json" with { type: "json" };

// These entries are not public API. Generated code imports most of them by path.
// `definition` is an entry so that `defineWorkflow` never shares a chunk with Node built-ins:
// the Vercel Workflow sandbox cannot load a flow bundle that keeps `require("node:async_hooks")`.
const privateEntries = new Set([
  "./definition",
  "./operations",
  "./runtime/cloudflare-runner",
  "./runtime/cloudflare-shared",
  "./runtime/cloudflare-vite",
  "./runtime/dev-runs",
  "./runtime/execute",
  "./runtime/vercel-vite",
])

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild", "#vitehub/workflow/registry"],
      onlyBundle: false,
    },
    entry: [
      "src/definition.ts",
      "src/durability.ts",
      "src/index.ts",
      "src/vite.ts",
      "src/operations.ts",
      "src/runtime/cloudflare-runner.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/cloudflare-shared.ts",
      "src/runtime/dev-runs.ts",
      "src/runtime/execute.ts",
      "src/runtime/openworkflow.ts",
      "src/openworkflow.ts",
      "src/runtime/state.ts",
      "src/runtime/vercel-vite.ts",
    ],
    exports: {
      customExports: (exports) => normalizePackageExports(Object.fromEntries(Object.entries({
        ...packageManifest.exports,
        ...exports,
      }).filter(([key]) => !privateEntries.has(key)))),
      inlinedDependencies: false,
    },
  },
});
