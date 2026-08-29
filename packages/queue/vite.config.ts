import { defineConfig } from "vite-plus";

export const queueVercelDeclarations = {
  name: "queue-vercel-declarations",
  generateBundle(_options: unknown, bundle: Record<string, { code: string, type: string }>) {
    for (const fileName of ["runtime/hosted.d.ts", "internal/runtime/vercel-vite.d.ts"]) {
      const chunk = bundle[fileName]
      if (chunk?.type === "chunk") {
        chunk.code = `/// <reference types="ws" />\n${chunk.code}`
      }
    }
  },
}

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    plugins: [queueVercelDeclarations],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild", "#vitehub/queue/registry"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/nuxt.ts",
      "src/vite.ts",
      "src/internal/runtime/cloudflare-client.ts",
      "src/internal/runtime/cloudflare-vite.ts",
      "src/internal/runtime/state.ts",
      "src/runtime/hosted.ts",
      "src/internal/runtime/vercel-client.ts",
      "src/internal/runtime/vercel-vite.ts",
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
