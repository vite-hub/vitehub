export type DeploymentPreset = "cloudflare" | "deno" | "netlify" | "node" | "vercel"

export type DeploymentHost = "cloudflare" | "deno-deploy" | "netlify" | "self-hosted" | "vercel"
export type DeploymentRuntime = "deno" | "node" | "workerd"
export type DeploymentService = "blob" | "queue" | "rateLimit" | "sandbox"

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
  queue: SupportedDeploymentServicePolicy<"cloudflare" | "vercel"> | UnsupportedDeploymentServicePolicy
  rateLimit: SupportedDeploymentServicePolicy<"cloudflare" | "memory", "native" | "process-local"> | UnsupportedDeploymentServicePolicy
  sandbox: SupportedDeploymentServicePolicy<"cloudflare" | "vercel"> | UnsupportedDeploymentServicePolicy
}

export type DeploymentServicePolicy = DeploymentServices[DeploymentService]

export interface DeploymentOutputPlan {
  directory: string
  entry?: string
  packaging: "deno-node-modules" | "none"
}

export interface DeploymentPlan {
  host: DeploymentHost
  nitroPreset: "cloudflare-module" | "deno-deploy" | "netlify" | "node-server" | "vercel"
  output: DeploymentOutputPlan
  preset: DeploymentPreset
  runtime: DeploymentRuntime
  services: DeploymentServices
}

const unsupported = (reason: string): UnsupportedDeploymentServicePolicy => ({ reason, supported: false })

const plans = {
  cloudflare: {
    host: "cloudflare",
    nitroPreset: "cloudflare-module",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "none" },
    preset: "cloudflare",
    runtime: "workerd",
    services: {
      blob: { adapter: "cloudflare-r2", guarantee: "native", supported: true },
      queue: { adapter: "cloudflare", guarantee: "native", supported: true },
      rateLimit: { adapter: "cloudflare", guarantee: "native", supported: true },
      sandbox: { adapter: "cloudflare", guarantee: "native", supported: true },
    },
  },
  deno: {
    host: "deno-deploy",
    nitroPreset: "deno-deploy",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "deno-node-modules" },
    preset: "deno",
    runtime: "deno",
    services: {
      blob: unsupported(
        "Deno Deploy has no built-in durable Blob Store with ViteHub's object-storage contract.",
      ),
      queue: unsupported(
        "Deno Deploy has no built-in Queue Provider with ViteHub's delivery contract.",
      ),
      rateLimit: unsupported("Deno Deploy has no built-in distributed Rate Limit driver."),
      sandbox: unsupported("Deno Deploy has no built-in isolated Sandbox Provider."),
    },
  },
  netlify: {
    host: "netlify",
    nitroPreset: "netlify",
    output: { directory: ".netlify", entry: "functions-internal/server/server.mjs", packaging: "none" },
    preset: "netlify",
    runtime: "node",
    services: {
      blob: { adapter: "netlify-blobs", guarantee: "native", supported: true },
      queue: unsupported(
        "Netlify has no built-in Queue Provider with ViteHub's delivery contract.",
      ),
      rateLimit: unsupported("Netlify has no built-in distributed Rate Limit driver."),
      sandbox: unsupported("Netlify has no built-in isolated Sandbox Provider."),
    },
  },
  node: {
    host: "self-hosted",
    nitroPreset: "node-server",
    output: { directory: ".output", entry: "server/index.mjs", packaging: "none" },
    preset: "node",
    runtime: "node",
    services: {
      blob: { adapter: "fs", guarantee: "single-host", supported: true },
      queue: unsupported("The Node preset has no built-in durable Queue Provider."),
      rateLimit: { adapter: "memory", guarantee: "process-local", supported: true },
      sandbox: unsupported("The Node preset has no built-in isolated Sandbox Provider."),
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
    preset: "vercel",
    runtime: "node",
    services: {
      blob: { adapter: "vercel-blob", guarantee: "native", supported: true },
      queue: { adapter: "vercel", guarantee: "native", supported: true },
      rateLimit: unsupported("Vercel has no built-in distributed Rate Limit driver."),
      sandbox: { adapter: "vercel", guarantee: "native", supported: true },
    },
  },
} as const satisfies Record<DeploymentPreset, DeploymentPlan>

export function resolveDeploymentPlan(preset: DeploymentPreset): DeploymentPlan {
  const plan = plans[preset]
  if (!plan) {
    throw new TypeError(`Unknown ViteHub deployment preset: ${JSON.stringify(preset)}.`)
  }
  return plan
}

export function normalizeNitroPreset(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-")
}

export function assertDeploymentService(plan: DeploymentPlan, service: DeploymentService): void {
  const policy = plan.services[service]
  if (policy.supported) return
  throw new Error(
    `[vitehub] The ${JSON.stringify(plan.preset)} preset cannot provide ${service}. ${policy.reason} Configure an explicit portable implementation through the owner package or disable this capability.`,
  )
}

export function deploymentPresetFromNitro(value?: string | null): DeploymentPreset | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-")
  if (!normalized) return
  if (normalized.startsWith("cloudflare")) return "cloudflare"
  if (normalized.startsWith("deno")) return "deno"
  if (normalized.startsWith("netlify")) return "netlify"
  if (normalized === "node" || normalized.startsWith("node-")) return "node"
  if (normalized.startsWith("vercel")) return "vercel"
}
