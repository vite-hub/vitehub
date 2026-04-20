export type HostingProvider = "cloudflare" | "vercel"

export function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

export function detectHosting(target?: { preset?: string } | undefined): HostingProvider | undefined {
  const preset = normalizeHosting(process.env.NITRO_PRESET || target?.preset)
  if (preset.includes("cloudflare") || process.env.CF_PAGES || process.env.CLOUDFLARE_WORKER) {
    return "cloudflare"
  }

  if (preset.includes("vercel") || process.env.VERCEL || process.env.VERCEL_ENV) {
    return "vercel"
  }

  return undefined
}
