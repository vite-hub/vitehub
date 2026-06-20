import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild", "#vitehub/workflow/registry"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/vite.ts",
      "src/runtime/cloudflare-runner.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/cloudflare-shared.ts",
      "src/runtime/execute.ts",
      "src/runtime/openworkflow.ts",
      "src/runtime/openworkflow-worker.ts",
      "src/runtime/state.ts",
      "src/runtime/vercel-vite.ts",
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
