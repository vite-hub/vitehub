import {
  ApprovalRequiredError,
  CapabilityNotFoundError,
  ViteHubError,
  type ViteHubErrorShape,
} from "@vite-hub/runtime"

const error = new ViteHubError("PROVIDER_FAILED", "The provider request failed.", {
  details: { provider: "fixture" },
  retryable: true,
})

error.toJSON() satisfies ViteHubErrorShape<"PROVIDER_FAILED", { provider: string }>
new CapabilityNotFoundError("kv").code satisfies "CAPABILITY_NOT_FOUND"
new ApprovalRequiredError({ id: "approval-1", state: "awaiting-approval" }).toJSON() satisfies ViteHubErrorShape<"APPROVAL_REQUIRED">
