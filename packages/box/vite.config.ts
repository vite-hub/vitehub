import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/internal/cloudflare.ts", "src/internal/vercel.ts"],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => [
            key === "./internal/cloudflare"
              ? "./_internal/cloudflare"
              : key === "./internal/vercel"
                ? "./_internal/vercel"
                : key,
            value,
          ]),
        )
      },
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
