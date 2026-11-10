export function isAmbiguousAgentWorkflowStartFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  try {
    if (!("code" in error) || !("details" in error)) return false
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    const details = (error as { details?: unknown }).details
    return (
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      (error as { code?: unknown }).code === "WORKFLOW_PROVIDER_OPERATION_FAILED" &&
      Boolean(
        details &&
        typeof details === "object" &&
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
  catch {
    return false
  }
}
