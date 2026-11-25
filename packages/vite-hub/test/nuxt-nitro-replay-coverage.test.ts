import { isIncludedNitroPlugin } from "@vite-hub/internal/build/included-nitro-registry"
import { describe, expect, it } from "vitest"
import type { Plugin, PluginOption } from "vite"

import { nitroConfigResolvedNames, nitroRuntimeResolver, nitroRuntimeResolverNames, nitroServerTransformNames, replaysNitroConfigResolved } from "../src/internal/nitro-replay.ts"
import { viteHubPlugins } from "../src/plugins.ts"

type ReplayHook = "resolveId" | "load" | "transform"
const replayHooks: readonly ReplayHook[] = ["resolveId", "load", "transform"]

const notReplayed: Record<string, { hooks: readonly ReplayHook[], reason: string }> = {
  "@vite-hub/agent/vite": { hooks: ["resolveId", "load"], reason: "The Agent Nitro config aliases its generated modules." },
  "@vite-hub/channels/vite": { hooks: ["resolveId", "load"], reason: "packages/channels/src/vite.ts configureNitroChannels aliases #vitehub/channels/registry to a generated file." },
  "@vite-hub/connections/vite": { hooks: ["resolveId", "load"], reason: "packages/connections/src/vite.ts aliases #vitehub/connections/registry to a generated file." },
  "@vite-hub/content/vite": { hooks: ["resolveId", "load", "transform"], reason: "The plugin's nitro.setup adds @vite-hub/content/nitro-kv for the KV registration. Without a Vite environment the build makes no Source snapshots, so a cold server parses glob() and files() Sources on its first read." },
  "@vite-hub/database/vite": { hooks: ["resolveId", "load", "transform"], reason: "@vite-hub/database/nuxt owns the Nitro aliases of the Database runtime." },
  "@vite-hub/env/vite": { hooks: ["resolveId", "load"], reason: "@vite-hub/env/vite createEnvImportAliases gives Nitro the generated #vitehub/env/* files as aliases." },
  "@vite-hub/kv/optional-peers": { hooks: ["resolveId"], reason: "Optional peer stubs; Nuxt aliases the disabled KV drivers itself." },
  "@vite-hub/sandbox/task/vite": { hooks: ["resolveId", "load"], reason: "The plugin's nitro.setup aliases @vite-hub/sandbox/task to the generated facade (#5462)." },
  "@vite-hub/workspace/vite": { hooks: ["resolveId", "load"], reason: "configureNitroWorkspaceAssets aliases the assets registry for a Nitro build outside Vite." },
  "vite-hub/cloudflare-node-dev": { hooks: ["resolveId", "load"], reason: "Nuxt writes its own Cloudflare dev shims (writeCloudflareDevShims)." },
  "vite-hub/console": { hooks: ["resolveId", "transform"], reason: "Nuxt sets the #vitehub/console/app Nitro alias directly and installs consoleOperationFeatures() in Nitro (installNitroBuildPlugins)." },
  "vite-hub/database-disabled": { hooks: ["resolveId", "load"], reason: "Nuxt sets the disabled Database aliases on the Nitro config." },
  "vite-hub/dependencies": { hooks: ["resolveId", "load"], reason: "Facade aliases also go to Nitro through the replayed config hook." },
  "vite-hub/deployment-host": { hooks: ["resolveId"], reason: "Vite-host only; Nuxt runs its own Nitro." },
  "vite-hub/drizzle-build-check": { hooks: ["resolveId"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/forge-build-check": { hooks: ["resolveId", "load"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/nitro-cache-bypass": { hooks: ["resolveId", "load"], reason: "installNitroBuildPlugins adds its own instance to Nitro." },
  "vite-hub/vitest-inline": { hooks: ["resolveId", "load"], reason: "Vitest only." },
}

const viteBuild = "Nuxt runs it in its own Vite build of the app, with the same plugin object, before Nitro builds."

const configResolvedNotReplayed: Record<string, string> = {
  "@vite-hub/agent/vite": `${viteBuild} It writes the Agent registry that Nitro aliases. KNOWN GAP: A Nuxt build cache hit skips Vite and can leave the registry pointing to stale Agent Definition paths.`,
  "@vite-hub/channels/vite": "The config hook writes the Nitro Channels registry when it sees the Nitro replay (configureNitroChannels).",
  "@vite-hub/cms/vite": `${viteBuild} It only checks the cms preset requirements.`,
  "@vite-hub/comments/vite": `${viteBuild} It only checks the Comments Definition.`,
  "@vite-hub/connections/types-cleanup": "Nuxt calls the plugin's prepareTypes API itself.",
  "@vite-hub/connections/vite": "The config hook writes the Nitro Connections registry when it sees the Nitro replay.",
  "@vite-hub/email/optional-peer-resolver": "Nuxt calls the plugin's prepareTypes API itself.",
  "@vite-hub/queue/vite": "Nuxt calls the plugin's Queue Nitro config handler in the replay (queueNitroConfigHandler).",
  "@vite-hub/rate-limit/vite": "The config hook merges the Nitro config. Nuxt calls validateNitroBuild for a build.",
  "@vite-hub/workspace/vite": `${viteBuild} The Nitro config hook aliases the assets registry. KNOWN GAP: A Nuxt build cache hit skips the Vite hooks that write the registry, so it can be missing when only the Nuxt cache is restored.`,
  "vite-hub/cloudflare-redirects-file": "It keeps the config only to report hints, and Nuxt defers hints to the Nitro build.",
  "vite-hub/console": "Nuxt filters the Console plugin out and installs consoleOperationFeatures() in Nitro (installNitroBuildPlugins).",
  "vite-hub/database-disabled": "Its state feeds its own resolveId and load. Nuxt sets the disabled Database aliases on the Nitro config.",
  "vite-hub/definition-features-root": `${viteBuild} It only checks the Definition root.`,
  "vite-hub/dependencies": "Its aliases feed its own resolveId. Nuxt sets the Env and disabled KV driver aliases on the Nitro config.",
  "vite-hub/deployment-output": "Nuxt leaves it out of the Vite plugins. Its config hook reads the plugins when it sees the Nitro replay.",
  "vite-hub/hints": "Nuxt starts the hints itself on nitro:build:before.",
  "vite-hub/nitro-order": `${viteBuild} It only checks the plugin order.`,
  "vite-hub/observability": `${viteBuild} It only checks the host of the Agents.`,
  "vite-hub/operations": `${viteBuild} It only checks that operation names are unique.`,
  "vite-hub/types": "Nuxt calls the plugin's prepareTypes API itself.",
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

  it("replays or explains every configResolved hook in a build without a Vite environment", () => {
    const unexplained = [...plugins.values()]
      .filter(plugin => plugin.configResolved !== undefined && !replaysNitroConfigResolved(plugin.name, true) && !configResolvedNotReplayed[plugin.name])
      .map(plugin => plugin.name)
    expect(unexplained, "Add the plugin to nitroConfigResolvedNames in src/internal/nitro-replay.ts, or to configResolvedNotReplayed with the reason").toEqual([])
  })

  it("lists no configResolved exception that the replay runs or that has no hook", () => {
    const stale = Object.keys(configResolvedNotReplayed).filter((name) => {
      const plugin = plugins.get(name)
      return !plugin?.configResolved || replaysNitroConfigResolved(name, true)
    })
    expect(stale).toEqual([])
  })

  it("names only plugins that exist in the replay lists", () => {
    const missing = [...nitroRuntimeResolverNames, ...nitroServerTransformNames, ...nitroConfigResolvedNames].filter(name => !plugins.has(name))
    expect(missing).toEqual([])
  })

  it("adds only plugins with a configResolved hook to nitroConfigResolvedNames", () => {
    const withoutHook = [...nitroConfigResolvedNames].filter(name => !nitroRuntimeResolverNames.has(name) && !plugins.get(name)?.configResolved)
    expect(withoutHook).toEqual([])
  })
})
