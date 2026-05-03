import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/cloudflare.ts",
    "src/nitro.ts",
    "src/runtime/cloudflare-workers-dev.ts",
    "src/runtime/nitro-runtime-config.ts",
    "src/runtime/nitro-plugin.ts",
    "src/vercel.ts",
    "src/vite.ts",
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
