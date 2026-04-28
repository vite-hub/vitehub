import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/drizzle-subpath.d.ts", rename: "drizzle-subpath.d.ts", to: "dist" },
    { from: "src/virtual-module.d.ts", rename: "virtual-module.d.ts", to: "dist" },
  ],
  dts: true,
  entry: [
    "src/index.ts",
    "src/drizzle.ts",
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
