#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { createMigrateCliNamespace } from "./migrate-cli.ts"
import { createSandboxCliNamespace } from "./sandbox-cli.ts"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"
import { importOptionalOwner, requireOptionalOwner } from "./internal/optional-owners.ts"
import { secretCliFeatures } from "@vite-hub/env/cli"

import type { ViteHubCliCommandNamespace } from "@vite-hub/internal/cli"

// `agent invocations` talks to a server or a journal database, so a broken or slow project config cannot block it.
const agentRuntimeFeatures: ViteHubCliCommandNamespace = {
  features: [{
    name: "invocations",
    run: async (args, context) => requireOptionalOwner(await importOptionalOwner("@vite-hub/agent", () => import("@vite-hub/agent/cli")), "agent").runAgentInvocationsCli(args, context),
  }],
  name: "agent",
}

// Connections and Decisions are optional peers. Their commands exist when the app installed the package.
// The Connections commands load jose and valibot, so only `vitehub connections` imports them.
const [connectionsCli, decisionsCli] = await Promise.all([
  process.argv[2] === "connections" ? importOptionalOwner("@vite-hub/connections", () => import("@vite-hub/connections/cli")) : undefined,
  importOptionalOwner("@vite-hub/decisions", () => import("@vite-hub/decisions/cli")),
])

// `vitehub kv get` and the other KV commands call the running dev server, like `connections`.
const kvCli = process.argv[2] === "kv" ? await importOptionalOwner("@vite-hub/kv", () => import("@vite-hub/kv/cli")) : undefined

// `vitehub bundle` reads the report of the last build in .vitehub/bundle/, so it does not load the project.
const bundleCli = process.argv[2] === "bundle" ? await import("@vite-hub/bundle/cli") : undefined

// Directory checks read the working tree and must work without a project or Content discovery.
const contentArgs = process.argv.slice(4)
const contentTerminator = contentArgs.indexOf("--")
const contentCli = process.argv[2] === "content" && process.argv[3] === "check" && contentArgs.slice(0, contentTerminator < 0 ? undefined : contentTerminator).includes("--dir")
  ? await import("@vite-hub/content/cli")
  : undefined
const contentRuntimeFeatures = contentCli?.createContentCliContributor().namespaces.map(namespace => ({
  ...namespace,
  features: namespace.features.filter(feature => feature.name === "check"),
})) ?? []

const secretRuntimeNamespace: ViteHubCliCommandNamespace = {
  description: "Generate and derive app secrets without loading project configuration.",
  features: secretCliFeatures,
  name: "secret",
}

runViteHubCliEntrypoint({
  loadConfig: loadViteHubCliConfig,
  runtimeFeatureGuard: async (namespace, feature, cwd) => {
    if (namespace !== "agent" || feature !== "invocations") return true
    const { isAgentCliEnabled } = await import("./internal/runtime-feature-guard.ts")
    return isAgentCliEnabled(cwd)
  },
  // `connections` and `kv` commands only call the running app. Loading the project runs every ViteHub plugin, and the
  // server files that they generate make the running dev server rebuild while the command waits for its answer.
  runtimeFeatures: [agentRuntimeFeatures, ...connectionsCli?.createConnectionsCliContributor().namespaces ?? [], ...kvCli?.createKVCliContributor().namespaces ?? [], ...contentRuntimeFeatures],
  runtimeNamespaces: [...bundleCli?.bundleCliContributor.namespaces ?? [], ...decisionsCli ? [decisionsCli.createDecisionsCliNamespace()] : [], createMigrateCliNamespace(), createSandboxCliNamespace(), secretRuntimeNamespace],
})
