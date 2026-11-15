import { defineConfig } from "vite-plus";
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [{ from: "src/virtual-module.d.ts", to: "dist" }],
    plugins: [
      {
        name: "env-virtual-declarations",
        generateBundle(_options, bundle) {
          const chunk = bundle["virtual.d.ts"];
          if (chunk?.type === "chunk") {
            chunk.code = `/// <reference path="./virtual-module.d.ts" />\n${chunk.code}`;
          }
        },
      },
    ],
    deps: {
      neverBundle: ["vite", "@vite-hub/agent/env-identity", "#vitehub/env/public", "#vitehub/env/server"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/bridge.ts",
      "src/cli.ts",
      "src/internal/agent.ts",
      "src/internal/connections.ts",
      "src/internal/server.ts",
      "src/database.ts",
      "src/runtime/public-env.ts",
      "src/runtime/server-env.ts",
      "src/server.ts",
      "src/seal.ts",
      "src/virtual.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(
          Object.fromEntries(
            Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/")).map(([key, value]) => {
              if (typeof value !== "string" || !value.endsWith(".js")) {
                return [key, value];
              }
              return [
                key,
                {
                  types: value.replace(/\.js$/, ".d.ts"),
                  import: value,
                },
              ];
            }),
          ),
        );
      },
      inlinedDependencies: false,
    },
  },
});
