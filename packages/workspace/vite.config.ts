import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    alias: {
      stream: new URL("./src/internal/vercel-stream.ts", import.meta.url).pathname,
      undici: new URL("./src/internal/vercel-fetch.ts", import.meta.url).pathname,
    },
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/, /^@vercel\/blob/],
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
      "src/ai.ts",
      "src/cloudflare.ts",
      "src/collections.ts",
      "src/collections/client.ts",
      "src/hosted.ts",
      "src/hosted-vercel-blob.ts",
      "src/index.ts",
      "src/loader.ts",
      "src/mountx.ts",
      "src/nitro.ts",
      "src/nuxt.ts",
      "src/publish.ts",
      "src/runtime.ts",
      "src/runtime/workspace.ts",
      "src/source-metadata.ts",
      "src/runtime/empty-assets-registry.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/assets.ts",
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
        "runtime/assets",
        "runtime/empty-assets-registry",
        "runtime/empty-registry",
        "runtime/state",
        "runtime/workspace",
        "providers/github/store",
      ],
      customExports(exports) {
        exports["./internal/runtime/assets"] = "./dist/runtime/assets.js";
        exports["./internal/runtime/hosted"] = "./dist/hosted.js";
        exports["./internal/runtime/hosted-vercel-blob"] = "./dist/hosted-vercel-blob.js";
        exports["./internal/runtime/state"] = "./dist/runtime/state.js";
        exports["./internal/runtime/workspace"] = "./dist/runtime/workspace.js";
        exports["./internal/stores/github"] = "./dist/providers/github/store.js";

        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
            if (typeof value !== "string" || !value.endsWith(".js")) {
              return [key, value];
            }
            return [
              key,
              {
                types: value.replace(/\.js$/, ".d.ts"),
                import: value,
              },
            ];
          }),
        );
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
