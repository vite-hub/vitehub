import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

const exportNames: Record<string, string> = {
  "./internal/cloudflare": "./_internal/cloudflare",
  "./internal/host-toolchain": "./_internal/toolchain",
  "./internal/vercel": "./_internal/vercel",
  "./task/index": "./task",
}

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [
        "vite",
        "#vitehub-sandbox-task-provider-loader",
        "#vitehub-sandbox-task-registry",
        "@vite-hub/sandbox/task/runtime/provider-loader",
        "vitehub-sandbox-task-provider-loader",
        "virtual:vitehub-sandbox-task-provider-loader",
      ],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/ssh.ts",
      "src/internal/cloudflare.ts",
      "src/internal/host-toolchain.ts",
      "src/internal/vercel.ts",
      "src/task/index.ts",
      "src/task/vite.ts",
      "src/task/runtime/empty-registry.ts",
      "src/task/runtime/provider-loader.ts",
      "src/task/runtime/providers/cloudflare.ts",
      "src/task/runtime/providers/vercel.ts",
      "src/task/runtime/state.ts",
    ],
    exports: {
      exclude: [
        "task/runtime/providers/cloudflare",
        "task/runtime/providers/vercel",
      ],
      customExports(exports) {
        const renamed = Object.fromEntries(Object.entries(exports).map(([key, value]) => [exportNames[key] ?? key, value]))
        const taskExport = renamed["./task"]
        return normalizePackageExports({
          ...renamed,
          ...(taskExport ? { "./_internal/task/runtime": taskExport } : {}),
          "./_internal/task/runtime/providers/cloudflare": "./dist/task/runtime/providers/cloudflare.js",
          "./_internal/task/runtime/providers/vercel": "./dist/task/runtime/providers/vercel.js",
        })
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
