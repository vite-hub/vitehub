import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cloudflare.ts", "src/crabbox.ts", "src/vercel.ts"],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
    tsconfig: "tsconfig.build.json",
  },
})
