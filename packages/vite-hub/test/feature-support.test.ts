import { describe, expect, it } from "vitest"

import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { featureIds, featureSupport } from "@vite-hub/internal/features"
import type { Plugin, PluginOption } from "vite"

import { vitehub } from "../src/index.ts"

const presets: DeploymentPreset[] = ["cloudflare", "deno", "netlify", "node", "vercel"]

/** The error code of each feature that `vitehub()` checks, and when it checks. */
const checks: Partial<Record<FeatureId, { code: string, at: "vitehub" | "config" }>> = {
  browser: { at: "vitehub", code: "VITE_HUB_R0088" },
  email: { at: "vitehub", code: "VITE_HUB_R0089" },
  queue: { at: "config", code: "INTERNAL_R0002" },
  rateLimit: { at: "config", code: "INTERNAL_R0002" },
  sandboxTask: { at: "config", code: "INTERNAL_R0002" },
  schedule: { at: "vitehub", code: "VITE_HUB_R0086" },
}

/** Features whose owner package checks the host during the Nitro build, not `vitehub()`. */
const ownerChecked: FeatureId[] = ["realtime"]

function isCallable(value: unknown): value is CallableFunction {
  return typeof value === "function"
}

function findPlugin(plugins: PluginOption[], name: string): Plugin {
  const plugin = plugins.flat().find(candidate => candidate !== null && typeof candidate === "object" && "name" in candidate && candidate.name === name)
  if (!plugin || typeof plugin !== "object" || !("name" in plugin)) throw new TypeError(`Missing plugin ${name}.`)
  return plugin
}

function runConfigHook(plugin: Plugin): void {
  const hook = plugin.config
  const handler = isCallable(hook) ? hook : hook?.handler
  if (!isCallable(handler)) throw new TypeError("Expected a callable config hook.")
  Reflect.apply(handler, undefined, [{}, { command: "build", mode: "production" }])
}

function build(preset: DeploymentPreset, options: Record<string, unknown>): void {
  const plugins = vitehub({ preset, ...options })
  runConfigHook(findPlugin(plugins, "vite-hub/deployment-preset"))
}

describe("feature catalog host checks", () => {
  it("throws the existing code for every unsupported cell of the catalog", () => {
    for (const id of featureIds) {
      for (const preset of presets) {
        if (featureSupport(id, preset).level !== "unsupported" || ownerChecked.includes(id)) continue
        const check = checks[id]
        expect(check, `${id} on ${preset} has no vitehub() check`).toBeDefined()
        expect(() => build(preset, { [id]: true }), `${id} on ${preset}`).toThrow(expect.objectContaining({ code: check?.code }))
      }
    }
  })

  it("builds every native cell of the checked features", () => {
    for (const id of Object.keys(checks) as FeatureId[]) {
      for (const preset of presets) {
        if (featureSupport(id, preset).level !== "native") continue
        // A Node build checks Schedule wake-up separately, with VITE_HUB_R0137.
        const value = id === "schedule" && preset === "node" ? { providerOutput: "auto", runtime: { driver: "process" } } : true
        expect(() => build(preset, { [id]: value }), `${id} on ${preset}`).not.toThrow()
      }
    }
  })

  it("throws for an explicit cell only when the app does not choose the provider", () => {
    for (const preset of presets) {
      if (featureSupport("email", preset).level !== "explicit") continue
      expect(() => vitehub({ preset, email: true }), preset).toThrow(expect.objectContaining({ code: "VITE_HUB_R0089" }))
      expect(() => vitehub({ preset, email: { driver: "resend" } }), preset).not.toThrow()
    }
    expect(featureSupport("blob", "deno").level).toBe("explicit")
    expect(() => build("deno", { blob: true })).toThrow(expect.objectContaining({ code: "INTERNAL_R0002" }))
  })

  it("agrees with the Deployment Plan about the services that ViteHub selects", () => {
    const services = { blob: "blob", browser: "browser", queue: "queue", rateLimit: "rateLimit", sandbox: "sandboxTask" } as const
    for (const preset of presets) {
      const plan = resolveDeploymentPlan(preset)
      for (const [service, id] of Object.entries(services) as [keyof typeof services, FeatureId][]) {
        expect(featureSupport(id, preset).level === "native", `${id} on ${preset}`).toBe(plan.services[service].supported)
      }
    }
  })
})
