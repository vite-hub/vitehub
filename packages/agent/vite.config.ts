import { defineConfig } from "vite-plus";
import { isBuiltin } from "node:module";
import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

// These entries resolve only through the "#vitehub/agent/*" package imports, or generated code imports them by path
// (`agentRuntimeModule()` in `./vite`). They are not public exports.
const privateEntryExports = new Set([
  "./internal/workspace/internal/runtime/hosted",
  "./internal/workspace/internal/runtime/hosted-vercel-blob",
  "./internal/workspace/runtime",
  "./operations",
  "./provider-agent",
  "./runtime/invocations-dev",
  "./runtime/provider-agent-worker",
  "./runtime/recovery-leases",
  "./runtime/registry",
  "./runtime/workflow",
  "./server/registry",
  "./server/workspace",
]);

// These packages are only on pkg.pr.new, so the published manifest must not name them.
// Bundle them, and bundle what they import (such as their own Effect version), so npm installs need no URL.
const bundledPreviewPackages = /^(?:@vite-hub\/internal|@t3tools\/(?:provider-runtime|contracts)|forges)(?:\/|$)/;
const bundledPreviewImporters = /[\\/]node_modules[\\/](?:@t3tools[\\/](?:provider-runtime|contracts)|forges|effect)[\\/]/;

function alwaysBundle(id: string, importer: string | undefined): boolean {
  // The default invocation journal must work without the optional Database package.
  if (id === "@vite-hub/database/runtime/libsql-drizzle") return true;
  if (bundledPreviewPackages.test(id)) return true;
  return !!importer && bundledPreviewImporters.test(importer) && !isBuiltin(id);
}

export default defineConfig({
  pack: {
    ...packDefaults,
    outputOptions: {
      codeSplitting: {
        groups: [{ name: "vitehub-grants", test: /[/\\](?:access-runtime|channel-delivery-ownership)\.ts$/ }],
      },
    },
    deps: {
      alwaysBundle,
      neverBundle: [
        "vite",
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
        /^@emulators\//,
        /^vitest/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/capabilities.ts",
      "src/channels.ts",
      "src/durability.ts",
      "src/test/emulate-models.ts",
      "src/index.ts",
      "src/messages.ts",
      "src/internal/workspace/internal/runtime/hosted.ts",
      "src/internal/workspace/internal/runtime/hosted-vercel-blob.ts",
      "src/internal/workspace/runtime.ts",
      "src/env-identity.ts",
      "src/mcp.ts",
      "src/process.ts",
      "src/provider-agent.ts",
      "src/cloudflare.ts",
      "src/cli.ts",
      "src/eval.ts",
      "src/observability.ts",
      "src/observability/host.ts",
      "src/observability/posthog.ts",
      "src/operations.ts",
      "src/page.ts",
      "src/invocations/index.ts",
      // `vitehub agent emulator` loads only this entry, so it runs without a project or Agent config.
      "src/internal/agent-emulator-cli.ts",
      // `vitehub agent invocations` loads only this entry, so it runs where `vite` is not installed.
      "src/internal/agent-invocations-cli.ts",
      "src/internal/agent-state-cli.ts",
      "src/internal/default-invocations.ts",
      "src/internal/default-invocations-core.ts",
      "src/internal/default-invocations-libsql.ts",
      "src/invocations/app.ts",
      "src/invocations/database.ts",
      "src/invocations/drizzle.ts",
      "src/invocations/postgres.ts",
      "src/state.ts",
      "src/cloudflare/state.ts",
      "src/runtime/registry.ts",
      "src/runtime/invocations-dev.ts",
      "src/runtime/recovery-leases.ts",
      "src/runtime/provider-agent-worker.ts",
      "src/runtime/workflow.ts",
      "src/server.ts",
      "src/sessions.ts",
      "src/server/internal.ts",
      "src/server/registry.ts",
      "src/server/workspace.ts",
      "src/test.ts",
      "src/ui.ts",
      "src/ui/vue.ts",
      "src/usage.ts",
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
  },
});
