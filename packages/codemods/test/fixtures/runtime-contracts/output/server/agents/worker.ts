import { defineAgent } from "vite-hub/agent"
import { diagnostics, nodeRuntimeResources } from "vite-hub/agent/capabilities"

export default defineAgent({
  name: "worker",
  capabilities: [diagnostics({ resources: nodeRuntimeResources() })],
})
