import { defineConfig } from "vite-plus";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizePackageExports } from "@vite-hub/internal/package-exports";

// These entries resolve only through the "#vitehub/agent/provider-agent" package import, so they are not public exports.
const privateEntryExports = new Set(["./provider-agent", "./runtime/provider-agent-worker"]);

// These packages are only on pkg.pr.new, so the published manifest must not name them.
// Bundle them, and bundle what they import (such as their own Effect version), so npm installs need no URL.
const bundledPreviewPackages = /^(?:@vite-hub\/internal|@t3tools\/(?:provider-runtime|contracts)|forges)(?:\/|$)/;
const bundledPreviewImporters = /[\\/]node_modules[\\/](?:@t3tools[\\/](?:provider-runtime|contracts)|forges|effect)[\\/]/;

function alwaysBundle(id: string, importer: string | undefined): boolean {
  if (bundledPreviewPackages.test(id)) return true;
  return !!importer && bundledPreviewImporters.test(importer) && !isBuiltin(id);
}

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle,
      neverBundle: [
        "vite",
        "esbuild",
        "#vitehub/agent/registry",
        "#vitehub/agent/provider-agent",
        "#vitehub/env/server",
        "@vite-hub/env/internal/access",
        "@vite-hub/env/internal/agent",
        "@vercel/nft",
        "@vite-hub/rate-limit",
        "@vite-hub/connections/server",
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
      "src/env-identity.ts",
      "src/messages.ts",
      "src/mcp.ts",
      "src/mcp/stdio.ts",
      "src/output.ts",
      "src/process-host.ts",
      "src/provider-agent.ts",
      "src/cloudflare.ts",
      "src/cli.ts",
      "src/eval.ts",
      "src/eve.ts",
      "src/gateways.ts",
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
      "src/server/github.ts",
      "src/server/internal.ts",
      "src/server/registry.ts",
      "src/server/workspace.ts",
      "src/test.ts",
      "src/vue.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
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
        ));
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
