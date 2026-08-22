import { isRuntimeObject } from "./runtime-value.ts"

export function isAmbiguousAgentWorkflowStartFailure(error: unknown): boolean {
  if (!error || !isRuntimeObject(error) || !("code" in error) || !("details" in error)) return false
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const details = (error as { details?: unknown }).details
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  return (
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    (error as { code?: unknown }).code === "WORKFLOW_PROVIDER_OPERATION_FAILED" &&
    Boolean(
      details &&
      isRuntimeObject(details) &&
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      (details as { acknowledgement?: unknown }).acknowledgement === "unknown" &&
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      (((details as { provider?: unknown }).provider === "cloudflare" &&
        // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
        (details as { operation?: unknown }).operation === "create") ||
        // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
        ((details as { provider?: unknown }).provider === "openworkflow" &&
          // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
          (details as { operation?: unknown }).operation === "run")),
    )
  )
}
