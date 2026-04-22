import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" },
  ],
  dts: true,
  entry: [
    "src/config.ts",
    "src/ensure.ts",
    "src/storage.ts",
    "src/drivers/cloudflare.ts",
    "src/drivers/fs.ts",
    "src/drivers/vercel.ts",
    "src/index.ts",
    "src/nitro.ts",
    "src/vite.ts",
    "src/runtime/cloudflare-vite.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/storage.ts",
    "src/runtime/state.ts",
    "src/runtime/vercel-vite.ts",
    "src/virtual.ts",
  ],
  exports: {
    inlinedDependencies: false,
  },
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
