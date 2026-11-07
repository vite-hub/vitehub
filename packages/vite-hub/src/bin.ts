#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { createSandboxCliNamespace } from "./sandbox-cli.ts"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"
import { importOptionalOwner, requireOptionalOwner } from "./internal/optional-owners.ts"
import { secretCliFeatures } from "@vite-hub/env/cli"
import { createConnectionsCliContributor } from "@vite-hub/connections/cli"
import { createDecisionsCliNamespace } from "@vite-hub/decisions/cli"

import type { ViteHubCliCommandNamespace } from "@vite-hub/internal/cli"

// `agent invocations` talks to a server or a journal database, so a broken or slow project config cannot block it.
const agentRuntimeFeatures: ViteHubCliCommandNamespace = {
  features: [{
    name: "invocations",
    run: async (args, context) => requireOptionalOwner(await importOptionalOwner("@vite-hub/agent", () => import("@vite-hub/agent/cli")), "agent").runAgentInvocationsCli(args, context),
  }],
  name: "agent",
}

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
  // `connections` commands only call the running app. Loading the project runs every ViteHub plugin, and the server
  // files that they generate make the running dev server rebuild while the command waits for its answer.
  runtimeFeatures: [agentRuntimeFeatures, ...createConnectionsCliContributor().namespaces],
  runtimeNamespaces: [createDecisionsCliNamespace(), createSandboxCliNamespace(), secretRuntimeNamespace],
})
