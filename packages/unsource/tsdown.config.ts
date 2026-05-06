import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/sources/custom.ts",
    "src/sources/file.ts",
    "src/sources/github.ts",
    "src/sources/glob.ts",
    "src/sources/index.ts",
    "src/sources/markdown.ts",
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
