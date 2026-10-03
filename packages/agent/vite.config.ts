import { defineConfig } from "vite-plus";

// These entries resolve only through the "#vitehub/agent/provider-agent" package import, so they are not public exports.
const privateEntryExports = new Set(["./provider-agent", "./runtime/provider-agent-worker"]);

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [
        "vite",
        "esbuild",
        "#vitehub/agent/registry",
        "#vitehub/agent/provider-agent",
        "#vitehub/env/server",
        "@vercel/nft",
        "@t3tools/provider-runtime",
        "@vite-hub/rate-limit",
        "@vite-hub/workflow",
        /^@vite-hub\/workflow\//,
        "cloudflare:workers",
        /^@chat-adapter\/telegram$/,
        /^evlog(?:\/|$)/,
        /^posthog-node$/,
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
      "src/provider-agent.ts",
      "src/presets/workspace.ts",
      "src/cloudflare.ts",
      "src/cli.ts",
      "src/eval.ts",
      "src/eve.ts",
      "src/evlog.ts",
      "src/evlog/posthog.ts",
      "src/observability.ts",
      "src/observability/host.ts",
      "src/observability/posthog.ts",
      "src/invocations/d1.ts",
      "src/invocations/sqlite.ts",
      "src/state/sqlite.ts",
      "src/cloudflare/state.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/invocations-dev.ts",
      "src/runtime/process.ts",
      "src/runtime/provider-agent-worker.ts",
      "src/runtime/workflow.ts",
      "src/server.ts",
      "src/presets/babysitter.ts",
      "src/server/github.ts",
      "src/server/github-inbox.ts",
      "src/server/internal.ts",
      "src/server/workspace.ts",
      "src/test.ts",
      "src/vue.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).filter(([key]) => !privateEntryExports.has(key)).map(([key, value]) => {
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
