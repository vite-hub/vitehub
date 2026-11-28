import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

const exportNames: Record<string, string> = {
  "./internal/host-toolchain": "./internal/toolchain",
  "./task/index": "./task",
}

export default defineConfig({
  pack: {
    ...packDefaults,
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
      "src/task/runtime/providers/container.ts",
      "src/task/runtime/providers/local.ts",
      "src/task/runtime/providers/vercel.ts",
      "src/task/runtime/state.ts",
    ],
    exports: {
      exclude: [
        "task/runtime/providers/cloudflare",
        "task/runtime/providers/container",
        "task/runtime/providers/local",
        "task/runtime/providers/vercel",
      ],
      customExports(exports) {
        const renamed = Object.fromEntries(Object.entries(exports).map(([key, value]) => [exportNames[key] ?? key, value]))
        const taskExport = renamed["./task"]
        return normalizePackageExports({
          ...renamed,
          ...(taskExport ? { "./internal/task/runtime": taskExport } : {}),
          "./internal/task/runtime/providers/cloudflare": "./dist/task/runtime/providers/cloudflare.js",
          "./internal/task/runtime/providers/container": "./dist/task/runtime/providers/container.js",
          "./internal/task/runtime/providers/local": "./dist/task/runtime/providers/local.js",
          "./internal/task/runtime/providers/vercel": "./dist/task/runtime/providers/vercel.js",
        })
      },
      inlinedDependencies: false,
    },
  },
})
