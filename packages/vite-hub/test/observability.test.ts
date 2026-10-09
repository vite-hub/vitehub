import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { describe, expect, it, vi } from "vitest"
import { env } from "@vite-hub/env"
import evlog from "evlog/nitro/v3"
import { vitehub } from "../src/index.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

vi.mock("evlog/nitro/v3", async (importOriginal) => {
  const module = await importOriginal<typeof import("evlog/nitro/v3")>()
  return { ...module, default: vi.fn(module.default) }
})

type ObservabilityConfig = { root: string, env?: { server?: Record<string, unknown> }, nitro?: { modules?: unknown[], plugins?: string[] } }

function observabilityPlugin(options: Parameters<typeof vitehub>[0]): Plugin {
  const plugin = vitehub(options)
    .find((candidate): candidate is Plugin => !!candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/observability")
  if (!plugin) throw new Error("Missing observability plugin.")
  return plugin
}

describe("vitehub({ observability })", () => {
  it("declares the PostHog key, registers evlog, and generates the host plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-"))
    try {
      const apiKey = env({ optional: true, secret: true, source: env.source("POSTHOG_API_KEY") })
      const plugin = observabilityPlugin({
        preset: "node",
        agent: true,
        console: { exposure: "host-managed", authorize: hostManagedAuthorize },
        observability: { service: "support", environment: "production", posthog: { apiKey, host: "https://eu.i.posthog.com" }, evlog: { pretty: false, env: { service: "other", environment: "staging", version: "1.2.3" } }, papercuts: { eventPrefix: "acme.papercut" } },
      })
      const config: ObservabilityConfig = { root }
      // SAFETY: The plugin reads only the root and the ViteHub-owned env and nitro keys, which this fixture supplies.
      const hook = plugin.config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)
      await hook(config)

      expect(config.env?.server?.observability).toEqual({ posthog: { apiKey } })
      expect(config.nitro?.modules).toEqual([expect.objectContaining({ name: "evlog" })])
      expect(evlog).toHaveBeenLastCalledWith(expect.objectContaining({ env: { service: "support", environment: "production", version: "1.2.3" } }))
      const generated = join(root, ".vitehub/nitro/observability/plugin.mjs")
      expect(config.nitro?.plugins).toEqual([generated])
      const source = await readFile(generated, "utf8")
      expect(source).toContain(`import { installObservability } from "@vite-hub/agent/observability/host"`)
      expect(source).toContain(`import { posthog } from "@vite-hub/agent/observability/posthog"`)
      expect(source).toContain("loadServerEnv()")
      expect(source).toContain(`papercuts: { ...{"eventPrefix":"acme.papercut"}, invocations: getConsoleInvocations }`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses normalized identity tags for request and Agent telemetry", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-tags-"))
    try {
      const plugin = observabilityPlugin({ preset: "node", observability: { service: " support ", environment: "  " } })
      const config: ObservabilityConfig = { root }
      const hook = plugin.config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)
      expect(evlog).toHaveBeenLastCalledWith(expect.objectContaining({ env: { service: "support", environment: "production" } }))
      const source = await readFile(join(root, ".vitehub/nitro/observability/plugin.mjs"), "utf8")
      expect(source).toContain('"service":"support","environment":"production"')
    }
    finally { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }) }
  })

  it.each([
    { preset: "netlify" as const, agent: true },
    { preset: "node" as const, agent: { runtime: "deno" as const } },
  ])("rejects standalone Agent output: %j", (target) => {
    const plugin = observabilityPlugin({ ...target, observability: { service: "support" } })
    // SAFETY: The hook reads only the hosting and Agent config supplied through vitehub().
    const hook = plugin.configResolved as (config: {}) => void
    expect(() => hook({})).toThrow("Nitro-hosted Agents")
  })

  it("rejects a final config override to standalone Agents", () => {
    const plugin = observabilityPlugin({ preset: "node", agent: true, observability: { service: "support" } })
    // SAFETY: The hook only reads these public config keys.
    const hook = plugin.configResolved as (config: { agent?: { runtime: string }, nitro?: { preset: string } }) => void
    expect(() => hook({ agent: { runtime: "deno" } })).toThrow("Nitro-hosted Agents")
    expect(() => hook({ nitro: { preset: "netlify" } })).toThrow("Nitro-hosted Agents")
  })

  it("rejects options it cannot honor", () => {
    expect(() => vitehub({ preset: "node", observability: { service: " " } })).toThrow("non-empty service name")
    expect(() => vitehub({ preset: "node", agent: true, observability: { service: "support", papercuts: true } })).toThrow("Enable agent and console")
    expect(() => vitehub({ preset: "node", env: false, observability: { service: "support", posthog: { apiKey: "key" } } })).toThrow("Remove env: false")
  })
})
