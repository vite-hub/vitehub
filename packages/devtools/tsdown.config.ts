import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/chat-shared.ts",
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
