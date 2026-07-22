import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"

const error = new ViteHubError("PROVIDER_FAILED", "The provider request failed.", {
  details: { provider: "fixture" },
})

error.toJSON() satisfies ViteHubErrorShape<"PROVIDER_FAILED", { provider: string }>
new ViteHubError("CAPABILITY_NOT_FOUND", "Capability was not found.").code satisfies "CAPABILITY_NOT_FOUND"
new ViteHubError("APPROVAL_REQUIRED", "Approval is required.", {
  details: { id: "approval-1", state: "awaiting-approval" },
}).toJSON() satisfies ViteHubErrorShape<"APPROVAL_REQUIRED", { id: string, state: string }>
