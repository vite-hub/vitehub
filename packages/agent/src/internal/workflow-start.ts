export function isAmbiguousAgentWorkflowStartFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || !("details" in error)) return false
  const details = (error as { details?: unknown }).details
  return (error as { code?: unknown }).code === "WORKFLOW_PROVIDER_OPERATION_FAILED"
    && Boolean(details && typeof details === "object"
      && (details as { acknowledgement?: unknown }).acknowledgement === "unknown"
      && (((details as { provider?: unknown }).provider === "cloudflare"
        && (details as { operation?: unknown }).operation === "create")
      || ((details as { provider?: unknown }).provider === "openworkflow"
        && (details as { operation?: unknown }).operation === "run")))
}
