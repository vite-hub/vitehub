import { isIncludedNitroPlugin } from "@vite-hub/internal/build/included-nitro-registry"
import { describe, expect, it } from "vitest"
import type { Plugin, PluginOption } from "vite"

import { nitroRuntimeResolver, nitroRuntimeResolverNames, nitroServerTransformNames } from "../src/internal/nitro-replay.ts"
import { viteHubPlugins } from "../src/plugins.ts"

type ReplayHook = "resolveId" | "load" | "transform"
const replayHooks: readonly ReplayHook[] = ["resolveId", "load", "transform"]

const notReplayed: Record<string, { hooks: readonly ReplayHook[], reason: string }> = {
  "@vite-hub/agent/vite": { hooks: ["resolveId", "load", "transform"], reason: "The Agent Nitro config aliases its generated modules. KNOWN GAP: Nitro runs transformWorkspaceAgent instead of the original transform that registers named Channels." },
  "@vite-hub/channels/vite": { hooks: ["resolveId", "load"], reason: "packages/channels/src/vite.ts configureNitroChannels aliases #vitehub/channels/registry to a generated file." },
  "@vite-hub/connections/vite": { hooks: ["resolveId", "load"], reason: "packages/connections/src/vite.ts aliases #vitehub/connections/registry to a generated file." },
  "@vite-hub/content/vite": { hooks: ["resolveId", "load", "transform"], reason: "The plugin's nitro.setup adds @vite-hub/content/nitro-kv for the KV registration. Without a Vite environment the build makes no Source snapshots, so a cold server parses glob() and files() Sources on its first read." },
  "@vite-hub/database/vite": { hooks: ["resolveId", "load", "transform"], reason: "@vite-hub/database/nuxt owns the Nitro aliases of the Database runtime." },
  "@vite-hub/env/vite": { hooks: ["resolveId", "load"], reason: "@vite-hub/env/vite createEnvImportAliases gives Nitro the generated #vitehub/env/* files as aliases." },
  "@vite-hub/kv/optional-peers": { hooks: ["resolveId"], reason: "Optional peer stubs; Nuxt aliases the disabled KV drivers itself." },
  "@vite-hub/sandbox/task/vite": { hooks: ["resolveId", "load"], reason: "The plugin's nitro.setup aliases @vite-hub/sandbox/task to the generated facade (#5462)." },
  "@vite-hub/workspace/vite": { hooks: ["resolveId", "load"], reason: "configureNitroWorkspaceAssets aliases the assets registry for a Nitro build outside Vite." },
  "vite-hub/cloudflare-node-dev": { hooks: ["resolveId", "load"], reason: "Nuxt writes its own Cloudflare dev shims (writeCloudflareDevShims)." },
  "vite-hub/console": { hooks: ["transform"], reason: "Nuxt filters the Console plugin out and installs consoleOperationFeatures() in Nitro (installNitroBuildPlugins)." },
  "vite-hub/database-disabled": { hooks: ["resolveId", "load"], reason: "Nuxt sets the disabled Database aliases on the Nitro config." },
  "vite-hub/dependencies": { hooks: ["resolveId", "load"], reason: "Facade aliases also go to Nitro through the replayed config hook." },
  "vite-hub/deployment-host": { hooks: ["resolveId"], reason: "Vite-host only; Nuxt runs its own Nitro." },
  "vite-hub/drizzle-build-check": { hooks: ["resolveId"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/forge-build-check": { hooks: ["resolveId", "load"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/nitro-cache-bypass": { hooks: ["resolveId", "load"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/vitest-inline": { hooks: ["resolveId", "load"], reason: "Vitest only." },
}

const features: Record<string, unknown> = {
  agent: true, auth: true, blob: true, browser: true, cache: true, channels: true, cms: true, comments: true, connections: true,
  console: { auth: false }, content: true, database: true, docs: true, email: { driver: "log" }, env: {}, forms: true,
  i18n: { locales: ["en", "es"] }, kv: true, logs: true, markdownTemplate: true, mcp: { auth: false }, observability: true,
  queue: true, rateLimit: true, realtime: true, sandboxTask: true, schedule: true, seo: { sitemap: true }, shell: true,
  sync: true, webhooks: true, workflow: true, workspace: true,
}

function flatten(options: readonly PluginOption[]): Plugin[] {
  return options.flatMap((option): Plugin[] => {
    if (Array.isArray(option)) return flatten(option)
    return option && typeof option === "object" && "name" in option ? [option as Plugin] : []
  })
}

function collectPlugins(): Map<string, Plugin> {
  const plugins = new Map<string, Plugin>()
  for (const host of ["node", "cloudflare", "vercel"]) {
    for (const [feature, value] of Object.entries(features)) {
      if (feature === "browser" && host !== "cloudflare") continue
      for (const plugin of flatten(viteHubPlugins({ host, [feature]: value } as Parameters<typeof viteHubPlugins>[0]))) {
        if (!isIncludedNitroPlugin(plugin)) plugins.set(plugin.name, plugin)
      }
    }
  }
  return plugins
}

describe("Nuxt 4.7 Nitro replay coverage", () => {
  const plugins = collectPlugins()

  it("replays the i18n output hook that fills the Workspace inventory", () => {
    const i18n = plugins.get("@vite-hub/i18n/vite")!
    expect(nitroRuntimeResolver(i18n, {}, { root: process.cwd() })?.plugin.renderChunk).toBe(i18n.renderChunk)
  })

  it("replays or explains every server resolveId, load and transform hook", () => {
    const unexplained: string[] = []
    for (const plugin of plugins.values()) {
      const originalHooks = nitroRuntimeResolver(plugin, {}, { root: process.cwd() })?.originalHooks
      for (const hook of replayHooks) {
        if (plugin[hook] === undefined || originalHooks?.[hook] !== undefined) continue
        if (!notReplayed[plugin.name]?.hooks.includes(hook)) unexplained.push(`${plugin.name} ${hook}`)
      }
    }
    expect(unexplained, "Add the plugin to a replay list in src/internal/nitro-replay.ts, or to notReplayed with the reason").toEqual([])
  })

  it("lists no plugin or hook that no longer needs an exception", () => {
    const stale = Object.entries(notReplayed).flatMap(([name, { hooks }]) => {
      const plugin = plugins.get(name)
      if (!plugin) return [`${name}: no such plugin`]
      const originalHooks = nitroRuntimeResolver(plugin, {}, { root: process.cwd() })?.originalHooks
      return hooks.filter(hook => plugin[hook] === undefined || originalHooks?.[hook] !== undefined).map(hook => `${name} ${hook}`)
    })
    expect(stale).toEqual([])
  })

  it("names only plugins that exist in the replay lists", () => {
    const missing = [...nitroRuntimeResolverNames, ...nitroServerTransformNames].filter(name => !plugins.has(name))
    expect(missing).toEqual([])
  })
})
