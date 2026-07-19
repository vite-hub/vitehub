import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: [
      "src/index.ts",
      "src/providers/cloudflare.ts",
      "src/providers/just-bash.ts",
      { workspace: "src/workspace/index.ts" },
    ],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
