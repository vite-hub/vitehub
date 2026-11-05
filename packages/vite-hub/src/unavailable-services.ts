import type { DeploymentPlan, DeploymentService } from "@vite-hub/internal/deployment"
import type { Plugin } from "vite"

type OptionalService = Extract<DeploymentService, "browser" | "realtime">

interface ServiceAvailability {
  available: false
  fix: string
  preset: string
  reason: string
}

const services: Record<OptionalService, { label: string, ownerPlugin: string, fix: (plan: DeploymentPlan) => string }> = {
  browser: {
    label: "Browser",
    ownerPlugin: "@vite-hub/browser/vite",
    fix: plan => plan.services.browser.supported
      ? "Set `browser: true` in vitehub()."
      : "Deploy with the Cloudflare preset and set `browser: true` in vitehub().",
  },
  realtime: {
    label: "Realtime",
    ownerPlugin: "@vite-hub/realtime/vite",
    fix: plan => plan.preset === "node"
      ? "Set `realtime: { authority: \"memory\" }` in vitehub() for one Node.js process."
      : plan.services.realtime.supported
        ? "Set `realtime: true` in vitehub()."
        : "Deploy with the Cloudflare preset and set `realtime: true` in vitehub().",
  },
}

const availabilityId = (service: OptionalService) => `#vitehub/${service}/availability`

/**
 * Tells server code which optional services this build lacks, and why.
 *
 * Each owner package reads `#vitehub/<service>/availability`. Its Vite plugin serves `{ available: true }` when the
 * service is on. For a service that is off, this plugin serves the preset, the reason, and the fix, so imports still
 * build and calls fail with a message that names the host.
 */
export function unavailableServicesPlugin(plan: DeploymentPlan, enabled: Record<OptionalService, boolean>): Plugin {
  const modules = new Map<string, ServiceAvailability>()
  for (const service of Object.keys(services) as OptionalService[]) {
    if (enabled[service]) continue
    const { label, fix } = services[service]
    const policy = plan.services[service]
    modules.set(availabilityId(service), {
      available: false,
      fix: fix(plan),
      preset: plan.preset,
      reason: policy.supported ? `vitehub() does not enable ${label}.` : policy.reason,
    })
  }
  return {
    name: "vite-hub/unavailable-services",
    // Before Vite resolves the owner package's `imports` fallback.
    enforce: "pre",
    configResolved(config) {
      // A directly composed owner plugin, such as hubBrowser(), provides the service itself.
      for (const service of Object.keys(services) as OptionalService[]) {
        if (config.plugins.some(plugin => plugin.name === services[service].ownerPlugin)) modules.delete(availabilityId(service))
      }
    },
    resolveId(id) {
      if (modules.has(id)) return `\0${id}`
    },
    load(id) {
      const availability = id.startsWith("\0") ? modules.get(id.slice(1)) : undefined
      if (availability) return `export default ${JSON.stringify(availability)}\n`
    },
  }
}
