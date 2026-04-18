export type HostingRuntime = "cloudflare" | "node" | "vercel"

export function detectHostingRuntime(
  event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } } } | undefined,
  hosting?: string,
): HostingRuntime {
  const hostingHint = hosting?.toLowerCase() ?? ""

  if (
    hostingHint.includes("cloudflare")
    || event?.context?.cloudflare
    || event?.context?._platform?.cloudflare
  ) {
    return "cloudflare"
  }

  if (hostingHint.includes("vercel")) {
    return "vercel"
  }

  return process.env.VERCEL ? "vercel" : "node"
}
