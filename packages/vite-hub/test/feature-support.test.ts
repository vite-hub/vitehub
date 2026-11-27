import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { VITEHUB_PREPARE } from "@vite-hub/internal/build/vite"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { featureIds, featureSupport } from "@vite-hub/internal/features"
import type { hubSource } from "@vite-hub/source/vite"
import type { Plugin, PluginOption } from "vite"

import { vitehub } from "../src/index.ts"

const hosts: ViteHubHost[] = ["cloudflare", "deno", "netlify", "node", "vercel"]

/** The error code of each feature that `vitehub()` checks, and when it checks. */
const checks: Partial<Record<FeatureId, { code: string, at: "vitehub" | "config" }>> = {
  browser: { at: "vitehub", code: "VITE_HUB_R0088" },
  email: { at: "config", code: "VITE_HUB_R0089" },
  queue: { at: "config", code: "INTERNAL_R0002" },
  rateLimit: { at: "config", code: "INTERNAL_R0002" },
  sandboxTask: { at: "config", code: "INTERNAL_R0002" },
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

function runConfigHook(plugin: Plugin, config = {}): void {
  const hook = plugin.config
  const handler = isCallable(hook) ? hook : hook?.handler
  if (!isCallable(handler)) throw new TypeError("Expected a callable config hook.")
  Reflect.apply(handler, undefined, [config, { command: "build", mode: "production" }])
}

function build(host: ViteHubHost, options: Record<string, unknown>): void {
  const plugins = vitehub({ host, ...options })
  runConfigHook(findPlugin(plugins, "vite-hub/deployment-host"))
}

describe("feature catalog host checks", () => {
  it.each(["node", "cloudflare", "vercel"] as const)("generates the Content prewarm integration for %s", async (host) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "content-prewarm-host-"))
    try {
      await mkdir(join(projectRoot, "server"))
      await writeFile(join(projectRoot, "server/content.ts"), 'import { defineContent } from "vite-hub/content"\nimport { github } from "vite-hub/source"\nexport default defineContent({ sources: { docs: github({ repo: "acme/docs" }) } })\n')
      const source = findPlugin(vitehub({ host, queue: true }), "@vite-hub/source/vite") as ReturnType<typeof hubSource>
      await source.api.prepareSources({ projectRoot })
      const webhook = await readFile(join(projectRoot, ".vitehub/content/github-webhook.mjs"), "utf8")
      const queues = await source.vitehub.queues({ projectRoot, root: projectRoot })
      if (host === "vercel") {
        expect(webhook).toContain("export default defineContentGitHubWebhookHandler(content)\n")
        expect(queues).toEqual([])
      }
      else {
        expect(webhook).toContain('dynamicQueue.send("vitehub-content-prewarm", job)')
        expect(queues).toMatchObject([{ name: "vitehub-content-prewarm" }])
      }
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it("throws the existing code for every unsupported cell of the catalog", () => {
    for (const id of featureIds) {
      for (const host of hosts) {
        if (featureSupport(id, host).level !== "unsupported" || ownerChecked.includes(id)) continue
        const check = checks[id]
        expect(check, `${id} on ${host} has no vitehub() check`).toBeDefined()
        expect(() => build(host, { [id]: true }), `${id} on ${host}`).toThrow(expect.objectContaining({ code: check?.code }))
      }
    }
  })

  it("builds every native cell of the checked features", () => {
    for (const id of Object.keys(checks) as FeatureId[]) {
      for (const host of hosts) {
        if (featureSupport(id, host).level !== "native") continue
        expect(() => build(host, { [id]: true }), `${id} on ${host}`).not.toThrow()
      }
    }
  })

  it("fails a production build of email: true only when the host has no Email provider", () => {
    for (const host of hosts) {
      expect(() => vitehub({ host, email: true }), host).not.toThrow()
      expect(() => build(host, { email: { driver: "resend" } }), host).not.toThrow()
      if (featureSupport("email", host).level !== "explicit") continue
      expect(() => build(host, { email: true }), host).toThrow(expect.objectContaining({ code: "VITE_HUB_R0089" }))
    }
    expect(featureSupport("blob", "deno").level).toBe("explicit")
    expect(() => build("deno", { blob: true })).toThrow(expect.objectContaining({ code: "INTERNAL_R0002" }))
  })

  it("allows email: true during Nuxt type preparation on every host", () => {
    for (const host of hosts) {
      const plugins = vitehub({ host, email: true })
      expect(() => runConfigHook(findPlugin(plugins, "vite-hub/deployment-host"), { [VITEHUB_PREPARE]: true }), host).not.toThrow()
    }
  })

  it("agrees with the Deployment Plan about the services that ViteHub selects", () => {
    const services = { blob: "blob", browser: "browser", queue: "queue", rateLimit: "rateLimit", sandbox: "sandboxTask" } as const
    for (const host of hosts) {
      const plan = resolveDeploymentPlan(host)
      for (const [service, id] of Object.entries(services) as [keyof typeof services, FeatureId][]) {
        expect(featureSupport(id, host).level === "native", `${id} on ${host}`).toBe(plan.services[service].supported)
      }
    }
  })
})
