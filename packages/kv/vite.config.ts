import { defineConfig } from "vite-plus";

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["vite", "#vitehub/kv/config", "@vite-hub/kv", "@cloudflare/workers-types", "@vite-hub/kv/runtime/cloudflare-kv", "@vite-hub/kv/runtime/upstash-driver", /^unstorage\//],
      alwaysBundle: [/^@vite-hub\/internal/, "unstorage"],
      onlyBundle: false,
    },
    copy: [{ from: "src/virtual-module.d.ts", to: "dist" }],
    plugins: [{
      name: "kv-virtual-declarations",
      generateBundle(_options, bundle) {
        const chunk = bundle["virtual.d.ts"]
        if (chunk?.type === "chunk") {
          chunk.code = `/// <reference path="./virtual-module.d.ts" />\n${chunk.code}`
        }
      },
    }],
    entry: ["src/cli.ts", "src/errors.ts", "src/index.ts", "src/runtime/cloudflare-kv.ts", "src/runtime/dev.ts", "src/runtime/upstash-driver.ts", "src/vite.ts", "src/virtual.ts"],
    exports: {
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
