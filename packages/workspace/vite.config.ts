import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [
        "vite",
        "#vitehub-workspace-assets-registry",
        "#vitehub-workspace-registry",
        "@vercel/nft",
        /^@vite-hub\/sandbox/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/ai.ts",
      "src/cloudflare.ts",
      "src/index.ts",
      "src/loader.ts",
      "src/publish.ts",
      "src/runtime.ts",
      "src/runtime/empty-assets-registry.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/assets.ts",
      "src/runtime/state.ts",
      "src/server.ts",
      "src/providers/cloudflare/artifacts-store.ts",
      "src/providers/github/store.ts",
      "src/providers/vercel/blob-store.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      exclude: [
        "runtime/assets",
        "runtime/empty-assets-registry",
        "runtime/empty-registry",
        "runtime/state",
        "providers/cloudflare/artifacts-store",
        "providers/github/store",
        "providers/vercel/blob-store",
      ],
      customExports(exports) {
        exports["./internal/runtime/assets"] = "./dist/runtime/assets.js";
        exports["./internal/runtime/empty-assets-registry"] =
          "./dist/runtime/empty-assets-registry.js";
        exports["./internal/runtime/empty-registry"] = "./dist/runtime/empty-registry.js";
        exports["./internal/runtime/state"] = "./dist/runtime/state.js";
        exports["./internal/stores/cloudflare-artifacts"] =
          "./dist/providers/cloudflare/artifacts-store.js";
        exports["./internal/stores/github"] = "./dist/providers/github/store.js";
        exports["./internal/stores/vercel-blob"] = "./dist/providers/vercel/blob-store.js";

        return exports;
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
