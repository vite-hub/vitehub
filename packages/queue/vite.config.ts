import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild", "#vitehub/queue/registry"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/nuxt.ts",
      "src/vite.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/hosted.ts",
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
