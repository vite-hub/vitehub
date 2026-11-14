import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    // unstorage's root declarations import every driver's options. Unused drivers must not pull optional SDK types into KV's declarations.
    // Preserve package sideEffects metadata for other modules so ambient declarations stay out of runtime chunks.
    treeshake: { moduleSideEffects: id => id.startsWith("unstorage/drivers/") ? false : undefined },
    deps: {
      neverBundle: ["vite", "#vitehub/kv/config", "@vite-hub/kv", "@cloudflare/workers-types", "@vite-hub/kv/runtime/redis-driver", "@vite-hub/kv/runtime/upstash-driver", /^unstorage\//],
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
    entry: ["src/cli.ts", "src/durability.ts", "src/errors.ts", "src/index.ts", "src/operations.ts", "src/runtime/cloudflare-kv.ts", "src/runtime/cloudflare-request-env.ts", "src/runtime/unstorage-driver.ts", "src/runtime/nitro-plugin.ts", "src/runtime/redis-driver.ts", "src/runtime/upstash-driver.ts", "src/vite.ts", "src/virtual.ts"],
    exports: {
      // Generated code imports these modules by path. They are not public API.
      exclude: ["errors", "operations", "runtime/cloudflare-kv", "runtime/cloudflare-request-env", "runtime/unstorage-driver", "runtime/nitro-plugin"],
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
  },
});
