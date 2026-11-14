import { defineAgent } from "vite-hub/agent"
import { diagnostics } from "vite-hub/agent/capabilities"
import { nodeRuntimeResources } from "vite-hub/runtime/node"

export default defineAgent({
  name: "worker",
  capabilities: [diagnostics({ resources: nodeRuntimeResources() })],
})
