import { defineConfig } from "vite-plus";

const bundledFilesSdkDrivers = new Set([
  "akamai",
  "azure",
  "box",
  "digitalocean-spaces",
  "dropbox",
  "fs",
  "gcs",
  "google-drive",
  "hetzner",
  "minio",
  "onedrive",
  "s3",
  "storj",
  "supabase",
  "uploadthing",
]);

const filesSdkProviderPeers = [
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "@aws-sdk/s3-presigned-post",
  "@aws-sdk/s3-request-presigner",
  "@azure/identity",
  "@azure/storage-blob",
  "@google-cloud/storage",
  "@googleapis/drive",
  "@microsoft/microsoft-graph-client",
  "@supabase/storage-js",
  "box-typescript-sdk-gen",
  "dropbox",
  "google-auth-library",
  "uploadthing",
];

export default defineConfig({
  pack: {
    alias: {
      undici: new URL("./src/internal/vercel-fetch.ts", import.meta.url).pathname,
    },
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    deps: {
      neverBundle: ["vite", "esbuild", ...filesSdkProviderPeers],
      alwaysBundle: [
        /^@vite-hub\/internal/,
        /^@vite-hub\/netlify-blobs-runtime$/,
        /^@vercel\/blob/,
        /^files-sdk(?:\/|$)/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/config.ts",
      "src/content-type.ts",
      "src/errors.ts",
      "src/ensure.ts",
      "src/storage.ts",
      "src/drivers/akamai.ts",
      "src/drivers/azure.ts",
      "src/drivers/box.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/cloudflare-native.ts",
      "src/drivers/digitalocean-spaces.ts",
      "src/drivers/dropbox.ts",
      "src/drivers/fs.ts",
      "src/drivers/gcs.ts",
      "src/drivers/google-drive.ts",
      "src/drivers/hetzner.ts",
      "src/drivers/minio.ts",
      "src/drivers/netlify-blobs.ts",
      "src/drivers/onedrive.ts",
      "src/drivers/s3.ts",
      "src/drivers/storj.ts",
      "src/drivers/supabase.ts",
      "src/drivers/uploadthing.ts",
      "src/drivers/vercel.ts",
      "src/drivers/vercel-bundled.ts",
      "src/index.ts",
      "src/vite.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/state.ts",
      "src/runtime/vercel-vite.ts",
      "src/virtual.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports)
            .filter(([key]) => key !== "./drivers/vercel-bundled" && key !== "./storage")
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
