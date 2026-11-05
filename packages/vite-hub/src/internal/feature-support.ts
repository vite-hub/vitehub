import type { DeploymentPlan, DeploymentPreset, DeploymentService } from "@vite-hub/internal/deployment"
import { assertDeploymentService } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { featureSupport } from "@vite-hub/internal/features"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/** The features that `vitehub()` checks when the app turns them on, with the error for a host that cannot provide them. */
const featureErrors = {
  browser: () => viteHubErrorDiagnostics.VITE_HUB_R0088({ message: "[vitehub] Browser currently requires the Cloudflare deployment preset." }),
  email: () => viteHubErrorDiagnostics.VITE_HUB_R0089({ message: "[vitehub] email: true currently requires the Cloudflare deployment preset; configure an explicit Email driver for other presets." }),
  schedule: () => viteHubErrorDiagnostics.VITE_HUB_R0086({ message: "[vitehub] The \"deno\" preset cannot provide Schedule because its generated cron output is not part of the deployed Nitro entrypoint. Disable Schedule or compose an explicit Deno scheduling integration." }),
} satisfies Partial<Record<FeatureId, () => Error>>

export type CheckedFeature = keyof typeof featureErrors

/**
 * Throws when `preset` cannot provide the feature `id` that `options` turns on.
 * An `explicit` host needs the app to choose the provider. Only the `true` shorthand asks ViteHub to choose. An options
 * object goes to the owner package, which validates the option that the catalog names.
 */
export function assertFeatureSupported(id: CheckedFeature, preset: DeploymentPreset, options: Partial<Record<CheckedFeature, unknown>>): void {
  const value = options[id]
  if (!value) return
  const support = featureSupport(id, preset)
  if (support.level === "native" || (support.level === "explicit" && value !== true)) return
  throw featureErrors[id]()
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
export function assertHostService(plan: DeploymentPlan, service: HostSelectedService): void {
  if (featureSupport(serviceFeatures[service], plan.preset).level === "native") return
  assertDeploymentService(plan, service)
}
