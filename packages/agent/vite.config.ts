import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@ai-sdk\/harness/, /^@vite-hub\/internal/],
      neverBundle: [
        "vite",
        "esbuild",
        "#vitehub/agent/registry",
        "#vitehub/env/server",
        "@vercel/nft",
        "@vite-hub/rate-limit",
        "@vite-hub/workflow",
        /^@vite-hub\/workflow\//,
        "cloudflare:workers",
        /^@chat-adapter\/telegram$/,
        /^evalite/,
        /^vitest/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/ai-sdk.ts",
      "src/capabilities.ts",
      "src/channels.ts",
      "src/index.ts",
      "src/messages.ts",
      "src/mcp.ts",
      "src/mcp/stdio.ts",
      "src/output.ts",
      "src/cloudflare.ts",
      "src/cli.ts",
      "src/eval.ts",
      "src/eve.ts",
      "src/harness/local-sandbox.ts",
      "src/state/sqlite.ts",
      "src/cloudflare/state.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/workflow.ts",
      "src/server.ts",
      "src/server/internal.ts",
      "src/server/workspace.ts",
      "src/test.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
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
        );
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
