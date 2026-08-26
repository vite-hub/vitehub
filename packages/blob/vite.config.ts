import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      undici: new URL("./src/internal/vercel-fetch.ts", import.meta.url).pathname,
    },
  },
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    deps: {
      neverBundle: ["vite", "esbuild"],
      alwaysBundle: [/^@vite-hub\/internal/, /^@vercel\/blob/],
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
      "src/drivers/files.ts",
      "src/drivers/files-sdk.ts",
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
          Object.entries(exports).filter(([key]) =>
            key !== "./drivers/vercel-bundled" && key !== "./storage"
          ),
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
