import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" },
  ],
  deps: {
    onlyBundle: false,
    skipNodeModulesBundle: true,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/nitro.ts",
    "src/vite.ts",
    "src/runtime/cloudflare-vite.ts",
    "src/runtime/hosted.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/state.ts",
    "src/runtime/vercel-vite.ts",
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
