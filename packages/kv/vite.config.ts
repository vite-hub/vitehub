import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["vite", "#vitehub/kv/config", "@cloudflare/workers-types", "@vite-hub/kv/runtime/cloudflare-kv", "@vite-hub/kv/runtime/upstash-driver"],
      alwaysBundle: [/^@vite-hub\/internal/, /^unstorage(?:\/|$)/],
      onlyBundle: false,
    },
    copy: [{ from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" }],
    entry: ["src/errors.ts", "src/index.ts", "src/runtime/cloudflare-kv.ts", "src/runtime/upstash-driver.ts", "src/vite.ts", "src/virtual.ts"],
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
