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
      neverBundle: ["vite", "esbuild", "#vitehub/database/schema", "#vitehub/database/databases"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/config.ts",
      "src/drizzle.ts",
      "src/virtual.ts",
      "src/vite.ts",
      "src/runtime/cloudflare-vite.ts",
      "src/runtime/hosted.ts",
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
