import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [
      { from: "src/drizzle-subpath.d.ts", rename: "drizzle-subpath.d.ts", to: "dist" },
      { from: "src/virtual-module.d.ts", rename: "virtual-module.d.ts", to: "dist" },
    ],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild", "#vitehub/database/schema", "#vitehub/database/databases", "#vitehub/database/definition-defaults", "#vitehub/database/definition-runtime"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/config.ts",
      "src/drizzle.ts",
      "src/nuxt.ts",
      "src/virtual.ts",
      "src/vite.ts",
      "src/runtime/agent.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/definition-defaults.ts",
      "src/runtime/definition-hosted.ts",
      "src/runtime/definition-local.ts",
      "src/runtime/hosted.ts",
      "src/runtime/state.ts",
      "src/runtime/virtual-databases.ts",
      "src/runtime/virtual-schema.ts",
      "src/runtime/vercel-vite.ts",
    ],
    exports: {
      customExports(exports) {
        return {
          ...Object.fromEntries(
            Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/definition-")),
          ),
          "./runtime/cloudflare-env": "./dist/runtime/state.js",
        }
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
