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

const secretRuntimeNamespace: ViteHubCliCommandNamespace = {
  description: "Generate and derive app secrets without loading project configuration.",
  features: secretCliFeatures,
  name: "secret",
}

runViteHubCliEntrypoint({
  loadConfig: loadViteHubCliConfig,
  runtimeFeatureGuard: (namespace, feature, cwd) => namespace !== "agent" || feature !== "invocations" || isAgentCliEnabled(cwd),
  runtimeFeatures: [agentRuntimeFeatures],
  runtimeNamespaces: [createSandboxCliNamespace(), secretRuntimeNamespace],
})
