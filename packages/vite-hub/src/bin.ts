#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { createSandboxCliNamespace } from "./sandbox-cli.ts"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"
import { isAgentCliEnabled } from "./internal/runtime-feature-guard.ts"
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
const [connectionsCli, decisionsCli] = await Promise.all([
  importOptionalOwner("@vite-hub/connections", () => import("@vite-hub/connections/cli")),
  importOptionalOwner("@vite-hub/decisions", () => import("@vite-hub/decisions/cli")),
])

const secretRuntimeNamespace: ViteHubCliCommandNamespace = {
  description: "Generate and derive app secrets without loading project configuration.",
  features: secretCliFeatures,
  name: "secret",
}

runViteHubCliEntrypoint({
  loadConfig: loadViteHubCliConfig,
  runtimeFeatureGuard: (namespace, feature, cwd) => namespace !== "agent" || feature !== "invocations" || isAgentCliEnabled(cwd),
  // `connections` commands only call the running app. Loading the project runs every ViteHub plugin, and the server
  // files that they generate make the running dev server rebuild while the command waits for its answer.
  runtimeFeatures: [agentRuntimeFeatures, ...connectionsCli?.createConnectionsCliContributor().namespaces ?? []],
  runtimeNamespaces: [...decisionsCli ? [decisionsCli.createDecisionsCliNamespace()] : [], createSandboxCliNamespace(), secretRuntimeNamespace],
})
