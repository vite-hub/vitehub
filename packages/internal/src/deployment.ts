import { internalErrorDiagnostics } from "./error-diagnostics.ts"
/** The host that ViteHub builds for: the `host` option of `vitehub()` and the value of `VITEHUB_HOST`. */
export type ViteHubHost = "cloudflare" | "deno" | "netlify" | "node" | "vercel"
/** @deprecated Use ViteHubHost. Retained for internal consumers while the host rename lands. */
export type DeploymentPreset = ViteHubHost
export type DeploymentRuntime = "deno" | "node" | "workerd"
export type DeploymentService = "blob" | "browser" | "queue" | "rateLimit" | "realtime" | "sandbox"

type SupportedDeploymentServicePolicy<TAdapter extends string, TGuarantee extends string = "native"> = {
  adapter: TAdapter
  guarantee: TGuarantee
  supported: true
}

type UnsupportedDeploymentServicePolicy = {
  reason: string
  supported: false
}

export interface DeploymentServices {
  blob: SupportedDeploymentServicePolicy<"cloudflare-r2" | "fs" | "netlify-blobs" | "vercel-blob", "native" | "single-host"> | UnsupportedDeploymentServicePolicy
  browser: SupportedDeploymentServicePolicy<"cloudflare"> | UnsupportedDeploymentServicePolicy
  queue: SupportedDeploymentServicePolicy<"cloudflare" | "local" | "vercel", "native" | "single-host"> | UnsupportedDeploymentServicePolicy
  rateLimit: SupportedDeploymentServicePolicy<"cloudflare" | "memory", "native" | "process-local"> | UnsupportedDeploymentServicePolicy
  realtime: SupportedDeploymentServicePolicy<"cloudflare" | "node", "native"> | UnsupportedDeploymentServicePolicy
  sandbox: SupportedDeploymentServicePolicy<"cloudflare" | "vercel"> | UnsupportedDeploymentServicePolicy
}

export type DeploymentServicePolicy = DeploymentServices[DeploymentService]

export interface DeploymentOutputPlan {
  directory: string
  entry?: string
  packaging: "deno-node-modules" | "none"
}

export interface DeploymentPlan {
  host: ViteHubHost
  nitroPreset: "cloudflare-module" | "deno-deploy" | "netlify" | "node-server" | "vercel"
  output: DeploymentOutputPlan
  runtime: DeploymentRuntime
  services: DeploymentServices
}

const unsupported = (reason: string): UnsupportedDeploymentServicePolicy => ({ reason, supported: false })

const plans = {
  cloudflare: {
    host: "cloudflare",
    nitroPreset: "cloudflare-module",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "none" },
    runtime: "workerd",
    services: {
      blob: { adapter: "cloudflare-r2", guarantee: "native", supported: true },
      browser: { adapter: "cloudflare", guarantee: "native", supported: true },
      queue: { adapter: "cloudflare", guarantee: "native", supported: true },
      rateLimit: { adapter: "cloudflare", guarantee: "native", supported: true },
      realtime: { adapter: "cloudflare", guarantee: "native", supported: true },
      sandbox: { adapter: "cloudflare", guarantee: "native", supported: true },
    },
  },
  deno: {
    host: "deno",
    nitroPreset: "deno-deploy",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "deno-node-modules" },
    runtime: "deno",
    services: {
      blob: unsupported(
        "Deno Deploy has no built-in durable Blob Store with ViteHub's object-storage contract.",
      ),
      browser: unsupported("Deno Deploy has no built-in Browser Provider."),
      queue: unsupported(
        "Deno Deploy has no built-in Queue Provider with ViteHub's delivery contract.",
      ),
      rateLimit: unsupported("Deno Deploy has no built-in distributed Rate Limit driver."),
      realtime: unsupported("Deno Deploy has no shared room authority for Realtime."),
      sandbox: unsupported("Deno Deploy has no built-in isolated Sandbox Provider."),
    },
  },
  netlify: {
    host: "netlify",
    nitroPreset: "netlify",
    output: { directory: ".netlify", entry: "functions-internal/server/server.mjs", packaging: "none" },
    runtime: "node",
    services: {
      blob: { adapter: "netlify-blobs", guarantee: "native", supported: true },
      browser: unsupported("Netlify has no built-in Browser Provider."),
      queue: unsupported(
        "Netlify has no built-in Queue Provider with ViteHub's delivery contract.",
      ),
      rateLimit: unsupported("Netlify has no built-in distributed Rate Limit driver."),
      realtime: unsupported("Netlify has no shared room authority for Realtime."),
      sandbox: unsupported("Netlify has no built-in isolated Sandbox Provider."),
    },
  },
  node: {
    host: "node",
    nitroPreset: "node-server",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "none" },
    runtime: "node",
    services: {
      blob: { adapter: "fs", guarantee: "single-host", supported: true },
      browser: unsupported("The Node host has no built-in Browser Provider."),
      queue: { adapter: "local", guarantee: "single-host", supported: true },
      rateLimit: { adapter: "memory", guarantee: "process-local", supported: true },
      realtime: { adapter: "node", guarantee: "native", supported: true },
      sandbox: unsupported("The Node host has no built-in isolated Sandbox Provider."),
    },
  },
  vercel: {
    host: "vercel",
    nitroPreset: "vercel",
    output: {
      directory: ".vercel/output",
      entry: "functions/__server.func/index.mjs",
      packaging: "none",
    },
    runtime: "node",
    services: {
      blob: { adapter: "vercel-blob", guarantee: "native", supported: true },
      browser: unsupported("Vercel has no built-in Browser Provider."),
      queue: { adapter: "vercel", guarantee: "native", supported: true },
      rateLimit: unsupported("Vercel has no built-in distributed Rate Limit driver."),
      realtime: unsupported("Vercel has no shared room authority for Realtime."),
      sandbox: { adapter: "vercel", guarantee: "native", supported: true },
    },
  },
} as const satisfies Record<ViteHubHost, DeploymentPlan>

export function resolveDeploymentPlan(host: ViteHubHost): DeploymentPlan {
  const plan = plans[host]
  if (!plan) {
    throw internalErrorDiagnostics.INTERNAL_R0001({ message: `Unknown ViteHub host: ${JSON.stringify(host)}.` })
  }
  return plan
}

export function normalizeNitroPreset(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-")
}

export function assertDeploymentService(plan: DeploymentPlan, service: DeploymentService): void {
  const policy = plan.services[service]
  if (policy.supported) return
  throw internalErrorDiagnostics.INTERNAL_R0002({ message: `[vitehub] The ${JSON.stringify(plan.host)} host cannot provide ${service}. ${policy.reason} Configure an explicit portable implementation through the owner package or disable this capability.` })
}

/** Maps a host name or a Nitro preset name, such as `cloudflare-module` or `node-server`, to its ViteHub host. */
export function hostFromNitroPreset(value?: string | null): ViteHubHost | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-")
  if (!normalized) return
  if (normalized.startsWith("cloudflare")) return "cloudflare"
  if (normalized.startsWith("deno")) return "deno"
  if (normalized.startsWith("netlify")) return "netlify"
  if (normalized === "node" || normalized.startsWith("node-")) return "node"
  if (normalized.startsWith("vercel")) return "vercel"
}

// The variables that std-env reads to detect the provider, the same detection that Nitro uses without a preset.
// Cloudflare Pages (`CF_PAGES`) is not here: ViteHub's Cloudflare host builds a Worker.
export const providerHosts: ReadonlyArray<readonly [string, ViteHubHost]> = [
  ["WORKERS_CI", "cloudflare"],
  ["NETLIFY", "netlify"],
  ["NOW_BUILDER", "vercel"],
  ["VERCEL", "vercel"],
  ["VERCEL_ENV", "vercel"],
  ["DENO_DEPLOY", "deno"],
  ["DENO_DEPLOYMENT_ID", "deno"],
]

/**
 * Returns the ViteHub host that this process builds or runs on, or `undefined` when no variable names a host.
 * The order is `VITEHUB_HOST`, `NITRO_PRESET`, `SERVER_PRESET`, then the provider variables:
 * `WORKERS_CI` (Cloudflare Workers Builds), `NETLIFY`, `NOW_BUILDER`, `VERCEL` or `VERCEL_ENV`, then `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`.
 * `vitehub()` uses this result when `host` is omitted, and `"node"` when it is `undefined`.
 */
export function detectHost(env: Record<string, string | undefined> = process.env): ViteHubHost | undefined {
  for (const name of ["VITEHUB_HOST", "NITRO_PRESET", "SERVER_PRESET"]) {
    const host = hostFromNitroPreset(env[name])
    if (host) return host
  }
  return providerHosts.find(([name]) => env[name]?.trim())?.[1]
}
