import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/providers/cloudflare.ts",
    "src/providers/just-bash.ts",
    { workspace: "src/workspace/index.ts" },
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
