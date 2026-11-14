import { defineConfig } from "vite-plus";
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/, /^@vite-hub\/markdown-template/],
      neverBundle: [
        "vite",
        "#vitehub-workspace-assets-registry",
        "#vitehub-workspace-registry",
        "@vercel/nft",
        "vue",
        /^@vite-hub\/sandbox/,
        /^@vite-hub\/shell/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/blob-database.ts",
      "src/checkout.ts",
      "src/cloudflare.ts",
      "src/durability.ts",
      "src/files.ts",
      "src/hosted.ts",
      "src/hosted-vercel-blob.ts",
      "src/index.ts",
      "src/lineage.ts",
      "src/loader.ts",
      "src/operations.ts",
      "src/runtime.ts",
      "src/runtime/workspace.ts",
      "src/internal/path.ts",
      "src/source-metadata.ts",
      "src/runtime/empty-assets-registry.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/assets.ts",
      "src/runtime/registry.ts",
      "src/runtime/state.ts",
      "src/server.ts",
      "src/providers/github/store.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      exclude: [
        "hosted",
        "hosted-vercel-blob",
        // Generated code imports these modules by path. They are not public API.
        "operations",
        "runtime/assets",
        "runtime/empty-assets-registry",
        "runtime/empty-registry",
        "runtime/registry",
        "runtime/state",
        "runtime/workspace",
        "providers/github/store",
      ],
      customExports(exports) {
        exports["./internal/runtime/assets"] = "./dist/runtime/assets.js";
        exports["./internal/runtime/hosted"] = "./dist/hosted.js";
        exports["./internal/runtime/hosted-vercel-blob"] = "./dist/hosted-vercel-blob.js";
        exports["./internal/runtime/workspace"] = "./dist/runtime/workspace.js";
        exports["./internal/stores/github"] = "./dist/providers/github/store.js";

        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
            if (typeof value !== "string" || !value.endsWith(".js")) {
              return [key, value];
            }
            return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }];
          }),
        ));
      },
      inlinedDependencies: false,
    },
  },
});
