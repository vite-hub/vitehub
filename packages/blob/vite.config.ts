import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

import { filesSdkDriverPeers } from "./src/internal/files-sdk-peers.ts";

const bundledFilesSdkDrivers = new Set([
  "azure",
  "fs",
  "gcs",
  "minio",
  "s3",
]);

// Generated code imports these modules by path. They are not public API.
const privateEntries = new Set(["./config", "./drivers/vercel-bundled", "./errors", "./operations", "./runtime/signed", "./storage"]);

const filesSdkProviderPeers = [...new Set(Object.values(filesSdkDriverPeers).flat())].sort();

// `@vercel/blob` reads only `getVercelOidcToken()`. The `@vercel/oidc` root also loads `verifyVercelOidcToken()` and
// with it all of jose, which a bundle cannot drop from CommonJS. Bundle the one module that `@vercel/blob` calls.
const vercelOidcTokenReader = fileURLToPath(new URL(
  "get-vercel-oidc-token-with-refresh.js",
  pathToFileURL(createRequire(import.meta.resolve("@vercel/blob")).resolve("@vercel/oidc")),
));

export default defineConfig({
  pack: {
    ...packDefaults,
    alias: {
      "@vercel/oidc": vercelOidcTokenReader,
      "async-retry": fileURLToPath(new URL("./src/internal/vercel-retry.ts", import.meta.url)),
      "is-buffer": fileURLToPath(new URL("./src/internal/vercel-is-buffer.ts", import.meta.url)),
      throttleit: fileURLToPath(new URL("./src/internal/vercel-throttle.ts", import.meta.url)),
      undici: fileURLToPath(new URL("./src/internal/vercel-fetch.ts", import.meta.url)),
    },
    copy: [{ from: "src/virtual-module.d.ts", to: "dist" }],
    deps: {
      neverBundle: ["vite", "vue", "esbuild", "sharp", "@cf-wasm/photon", "@vercel/nft", "@vite-hub/blob", "@vite-hub/blob/runtime/state", ...filesSdkProviderPeers],
      alwaysBundle: [
        /^@vite-hub\/internal/,
        /^@vite-hub\/netlify-blobs-runtime$/,
        /^@vercel\/blob/,
        /^files-sdk(?:\/|$)/,
      ],
      onlyBundle: false,
    },
    plugins: [{
      name: "blob-virtual-declarations",
      generateBundle(_options, bundle) {
        const chunk = bundle["virtual.d.ts"]
        if (chunk?.type === "chunk") {
          chunk.code = `/// <reference path="./virtual-module.d.ts" />\n${chunk.code}`
        }
      },
    }],
    entry: [
      "src/cli.ts",
      "src/client.ts",
      "src/config.ts",
      "src/durability.ts",
      "src/errors.ts",
      "src/storage.ts",
      "src/drivers/azure.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/cloudflare-native.ts",
      "src/drivers/fs.ts",
      "src/drivers/gcs.ts",
      "src/drivers/minio.ts",
      "src/drivers/netlify-blobs.ts",
      "src/drivers/s3.ts",
      "src/drivers/vercel.ts",
      "src/drivers/vercel-bundled.ts",
      "src/index.ts",
      "src/internal/vercel-blob.ts",
      "src/media.ts",
      "src/operations.ts",
      "src/vite.ts",
      "src/runtime/signed.ts",
      "src/runtime/state.ts",
      "src/served.ts",
      "src/virtual.ts",
      "src/vue.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports)
            .filter(([key]) => !privateEntries.has(key))
            .map(([key, value]) => {
              const driver = key.match(/^\.\/drivers\/(.+)$/)?.[1];
              if (!driver || !bundledFilesSdkDrivers.has(driver) || typeof value !== "string") {
                return [key, value];
              }
              return [
                key,
                {
                  types: value.replace(/\.js$/, ".d.ts"),
                  default: value,
                },
              ];
            }),
        ));
      },
      inlinedDependencies: false,
    },
  },
});
