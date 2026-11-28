import type { DeploymentPlan, DeploymentService, ViteHubHost } from "@vite-hub/internal/deployment"
import { assertDeploymentService } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { featureSupport } from "@vite-hub/internal/features"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/** The features that `vitehub()` checks when the app turns them on, with the error for a host that cannot provide them. */
const featureErrors = {
  browser: () => viteHubErrorDiagnostics.VITE_HUB_R0088({ message: "[vitehub] Browser currently requires the Cloudflare host." }),
} satisfies Partial<Record<FeatureId, () => Error>>

export type CheckedFeature = keyof typeof featureErrors

/**
 * Throws when `host` cannot provide the feature `id` that `options` turns on.
 * An `explicit` host needs the app to choose the provider. Only the `true` shorthand asks ViteHub to choose. An options
 * object goes to the owner package, which validates the option that the catalog names.
 */
export function assertFeatureSupported(id: CheckedFeature, host: ViteHubHost, options: Partial<Record<CheckedFeature, unknown>>): void {
  const value = options[id]
  if (!value) return
  const support = featureSupport(id, host)
  if (support.level === "native" || (support.level === "explicit" && value !== true)) return
  throw featureErrors[id]()
}

/**
 * The Email driver that `email: true` selects: the host driver from the catalog, or `log` when the host has none.
 * A production build with `log` fails in `assertEmailBuildDriver()`.
 */
export function defaultEmailDriver(host: ViteHubHost): "cloudflare" | "log" {
  const support = featureSupport("email", host)
  return support.level === "native" && support.driver === "cloudflare" ? "cloudflare" : "log"
}

/** Throws when a production build has `email: true` on a host that has no default Email provider. */
export function assertEmailBuildDriver(host: ViteHubHost, email: unknown): void {
  if (email !== true || defaultEmailDriver(host) !== "log") return
  throw viteHubErrorDiagnostics.VITE_HUB_R0089({ message: `[vitehub] \`email: true\` has no default provider on the "${host}" host. \`vite dev\` keeps each message in the development outbox, but a production build must send real email.` })
}

/** The Deployment Plan services that the app can ask ViteHub to select from the host, and their features. */
const serviceFeatures = {
  blob: "blob",
  queue: "queue",
  rateLimit: "rateLimit",
  sandbox: "sandboxTask",
} as const satisfies Partial<Record<DeploymentService, FeatureId>>

export type HostSelectedService = keyof typeof serviceFeatures

/**
 * Throws when the host has no provider for `service`, which the app asks ViteHub to select. The catalog decides, and
 * the Deployment Plan gives the reason in the error. A parity test keeps the two in agreement.
 */
export function assertHostService(plan: DeploymentPlan, service: HostSelectedService, importSource?: string): void {
  const support = featureSupport(serviceFeatures[service], plan.host)
  if (support.level === "native") return
  assertDeploymentService(plan, service, { driverFix: support.level === "explicit" ? support.detail : undefined, importSource })
}
