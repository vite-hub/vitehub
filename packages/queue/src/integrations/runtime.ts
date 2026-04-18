export type HostingRuntime = "cloudflare" | "node" | "vercel"

/**
 * Sniff the active hosting runtime from an H3 event + hosting runtime-config.
 * Used by playgrounds / diagnostics to surface `cloudflare | vercel | node`.
 */
export function detectHostingRuntime(
  event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } } } | undefined,
  hosting?: string,
): HostingRuntime {
  if (hosting === "cloudflare-module" || event?.context?.cloudflare || event?.context?._platform?.cloudflare) {
    return "cloudflare"
  }
  return process.env.VERCEL ? "vercel" : "node"
}
