import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/providers/cloudflare.ts",
    "src/providers/github.ts",
    "src/providers/vercel.ts",
    "src/logs/error-extraction.ts",
  ],
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
