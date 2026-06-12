import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    entry: [
      "src/index.ts",
      "src/providers/cloudflare.ts",
      "src/providers/github.ts",
      "src/providers/vercel.ts",
      "src/logs/error-extraction.ts",
    ],
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
