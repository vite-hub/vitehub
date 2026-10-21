import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/ssh.ts", "src/internal/cloudflare.ts", "src/internal/host-toolchain.ts", "src/internal/vercel.ts"],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).map(([key, value]) => [
            key === "./internal/cloudflare"
              ? "./_internal/cloudflare"
              : key === "./internal/host-toolchain"
                ? "./_internal/toolchain"
                : key === "./internal/vercel"
                  ? "./_internal/vercel"
                  : key,
            value,
          ]),
        ))
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
