import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { describe, expect, it, vi } from "vitest"
import { env } from "@vite-hub/env"
import type { EnvVitePlugin } from "@vite-hub/env/vite"
import evlog from "evlog/nitro/v3"
import { vitehub } from "../src/index.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

vi.mock("evlog/nitro/v3", async (importOriginal) => {
  const module = await importOriginal<typeof import("evlog/nitro/v3")>()
  return { ...module, default: vi.fn(module.default) }
})

type ObservabilityConfig = { root: string, __vitehubProjectRoot?: string, nitro?: { modules?: unknown[], plugins?: string[] } }

function findPlugin(options: Parameters<typeof vitehub>[0], name: string): Plugin {
  const plugin = vitehub(options)
    .find((candidate): candidate is Plugin => !!candidate && typeof candidate === "object" && "name" in candidate && candidate.name === name)
  if (!plugin) throw new Error(`Missing ${name} plugin.`)
  return plugin
}

function observabilityPlugin(options: Parameters<typeof vitehub>[0]): Plugin {
  return findPlugin(options, "vite-hub/observability")
}

describe("vitehub({ observability })", () => {
  it("declares the PostHog key, registers evlog, and generates the host plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-"))
    try {
      const apiKey = env({ optional: true, secret: true, source: env.source("POSTHOG_API_KEY") })
      const options: Parameters<typeof vitehub>[0] = {
        host: "node",
        agent: true,
        console: { auth: false, authorize: hostManagedAuthorize },
        observability: { service: "support", environment: "production", posthog: { apiKey, host: "https://eu.i.posthog.com" }, evlog: { pretty: false, env: { service: "other", environment: "staging", version: "1.2.3" } }, papercuts: { eventPrefix: "acme.papercut" } },
      }
      const plugin = observabilityPlugin(options)
      // SAFETY: The Env plugin exposes its declarations through its documented API.
      const envPlugin = findPlugin(options, "@vite-hub/env/vite") as Plugin & EnvVitePlugin
      const config: ObservabilityConfig = { root }
      // SAFETY: The plugin reads only the root and the ViteHub-owned env and nitro keys, which this fixture supplies.
      const hook = plugin.config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)
      await hook(config)

      expect(envPlugin.api.resolveDeclarations(config)?.server?.observability).toEqual({ posthog: { apiKey } })
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

  it("registers only evlog without a service", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-plain-"))
    try {
      const options: Parameters<typeof vitehub>[0] = { host: "node", observability: true }
      const names = vitehub(options).flatMap(plugin => plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [])
      expect(names).toContain("vite-hub/observability")
      expect(names).not.toContain("vite-hub/error-log")
      const config: ObservabilityConfig = { root }
      const hook = observabilityPlugin(options).config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)
      expect(config.nitro?.modules).toEqual([expect.objectContaining({ name: "evlog" })])
      expect(config.nitro?.plugins ?? []).toEqual([])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses normalized identity tags for request and Agent telemetry", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-tags-"))
    try {
      const plugin = observabilityPlugin({ host: "node", observability: { service: " support ", environment: "  " } })
      const config: ObservabilityConfig = { root }
      const hook = plugin.config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)
      expect(evlog).toHaveBeenLastCalledWith(expect.objectContaining({ env: { service: "support", environment: "production" } }))
      const source = await readFile(join(root, ".vitehub/nitro/observability/plugin.mjs"), "utf8")
      expect(source).toContain('"service":"support","environment":"production"')
    }
    finally { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }) }
  })

  it("writes the host plugin at the project root when Vite runs from app/", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-observability-project-root-"))
    try {
      const appRoot = join(root, "app")
      await mkdir(appRoot)
      await writeFile(join(root, "package.json"), "{}")
      await writeFile(join(appRoot, "package.json"), "{}")
      const plugin = observabilityPlugin({ host: "node", observability: { service: "support" } })
      const config: ObservabilityConfig = { root: appRoot, __vitehubProjectRoot: root }
      const hook = plugin.config as (config: ObservabilityConfig) => Promise<void>
      await hook(config)

      const generated = join(root, ".vitehub/nitro/observability/plugin.mjs")
      expect(config.nitro?.plugins).toEqual([generated])
      await expect(readFile(generated, "utf8")).resolves.toContain("installObservability")
    }
    finally { await rm(root, { force: true, recursive: true }) }
  })

  it.each([
    { host: "netlify" as const, agent: { invocations: false as const } },
    { host: "node" as const, agent: { invocations: false as const, runtime: "deno" as const } },
  ])("rejects standalone Agent output: %j", (target) => {
    const plugin = observabilityPlugin({ ...target, observability: { service: "support" } })
    // SAFETY: The hook reads only the hosting and Agent config supplied through vitehub().
    const hook = plugin.configResolved as (config: {}) => void
    expect(() => hook({})).toThrow("Nitro-hosted Agents")
  })

  it("rejects a final config override to standalone Agents", () => {
    const plugin = observabilityPlugin({ host: "node", agent: true, observability: { service: "support" } })
    // SAFETY: The hook only reads the Nitro config key.
    const hook = plugin.configResolved as (config: { nitro?: { preset: string } }) => void
    expect(() => hook({ nitro: { preset: "netlify" } })).toThrow("Nitro-hosted Agents")
  })

  it("rejects options it cannot honor", () => {
    expect(() => vitehub({ host: "node", observability: { service: " " } })).toThrow("non-empty service name")
    expect(() => vitehub({ host: "node", agent: true, observability: { service: "support", papercuts: true } })).toThrow("Enable agent and console")
    expect(() => vitehub({ host: "node", env: false, observability: { service: "support", posthog: { apiKey: "key" } } })).toThrow("Remove env: false")
    expect(() => vitehub({ host: "node", observability: { posthog: { apiKey: "key" } } })).toThrow("require observability.service")
    expect(() => vitehub({ host: "node", observability: { service: "support", posthog: { apiKey: "key" } }, env: { server: { observability: env() } } })).toThrow("reserved for vitehub({ observability })")
  })
})
