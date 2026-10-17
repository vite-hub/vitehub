import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { VITEHUB_SERVER_DIRS, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHost } from "@vite-hub/internal/hosting"

import { discoverRealtimeDefinitions } from "./discovery.ts"
import { summarizeRealtimeDefinitions } from "./inspect.ts"

import type { ViteHubDefinitionSummary, ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, UserConfig } from "vite"
import type { RealtimeInspectionAuthority } from "./inspect.ts"
import type { DiscoveredRealtimeDefinition, RealtimeModuleOptions } from "./types.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

/** Where a contributed definition runs. */
export interface RealtimeContributionContext {
  /** The room authority of this build. Contributions only run when there is one. */
  authority: "cloudflare" | "memory"
  /** `.vitehub/nitro/realtime`, for generated definition files. */
  directory: string
  projectRoot: string
  serverDirs?: string[]
}

/** Definitions and Nitro plugins that another package adds, such as Content live editing. */
export interface RealtimeContribution {
  /** Generated definition files. A file in `server/realtime/` with the same name wins. */
  definitions?: Array<Pick<DiscoveredRealtimeDefinition, "handler" | "name">>
  /** Nitro plugin files to install with the Realtime route. */
  plugins?: string[]
}

export interface RealtimeVitePluginOptions extends RealtimeModuleOptions {
  importBase?: string
  /**
   * Adds definitions owned by another package. It runs only when the build has a room authority (Cloudflare Durable
   * Objects, or memory in development or with `authority: 'memory'`). Without one, Realtime leaves the contribution
   * out without an error, so the contributing feature can fall back.
   */
  contribute?: (context: RealtimeContributionContext) => Promise<RealtimeContribution | undefined> | RealtimeContribution | undefined
}

export type RealtimeVitePlugin = Plugin & { vitehub: ViteHubInspectionPluginMetadata }

export interface RealtimeInspectionOptions {
  /** Resolved room authority. Defaults to `auto`. */
  authority?: RealtimeInspectionAuthority
  projectRoot: string
  serverDirs?: string[]
  /** Definitions other packages contributed to this build, such as Content live editing. */
  contributed?: readonly DiscoveredRealtimeDefinition[]
}

/**
 * Lists Realtime Definitions with their document adapter, editor codec, identity, authorization,
 * persistence, and room authority, read statically from each definition file.
 */
export async function inspectRealtimeDefinitions(options: RealtimeInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  return await summarizeRealtimeDefinitions(
    options.projectRoot,
    [...discoverRealtimeDefinitions(options.projectRoot, options.serverDirs), ...options.contributed ?? []],
    options.authority ?? "auto",
  )
}

interface NitroConfig extends Record<string, unknown> {
  cloudflare?: Record<string, unknown>
  features?: Record<string, unknown>
  handlers?: Array<Record<string, unknown>>
  preset?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function configureCloudflareRealtime(nitro: NitroConfig): void {
  nitro.preset = "cloudflare-durable"
  const cloudflare = record(nitro.cloudflare)
  const wrangler = record(cloudflare.wrangler)
  const durableObjects = record(wrangler.durable_objects)
  const bindings = Array.isArray(durableObjects.bindings) ? durableObjects.bindings : []
  if (!bindings.some(binding => record(binding).name === "$DurableObject")) {
    durableObjects.bindings = [...bindings, { class_name: "$DurableObject", name: "$DurableObject" }]
  }
  const migrations = Array.isArray(wrangler.migrations) ? wrangler.migrations : []
  if (!migrations.some(migration => record(migration).tag === "vitehub-realtime-v1")) {
    wrangler.migrations = [
      ...migrations,
      { new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" },
    ]
  }
  wrangler.durable_objects = durableObjects
  cloudflare.wrangler = wrangler
  nitro.cloudflare = cloudflare
}

/** Packages that share the Yjs runtime on the server. They must load as one module graph. */
const realtimeServerYjsPackages = ["yjs", "y-protocols", "lib0", "@tiptap/y-tiptap", /^y-protocols\//, /^lib0\//]

function moduleSpecifier(from: string, to: string): string {
  const value = relative(dirname(from), to).replaceAll("\\", "/")
  return value.startsWith(".") ? value : `./${value}`
}

function applicationBaseURL(base: string | undefined): string {
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

export function hubRealtime(options: RealtimeVitePluginOptions = {}): RealtimeVitePlugin {
  const importBase = options.importBase ?? "@vite-hub/realtime"
  let inspectionRoot: string | undefined
  let inspectionServerDirs: string[] | undefined
  let inspectionAuthority: RealtimeInspectionAuthority = options.authority ?? "auto"
  let inspectionContributed: DiscoveredRealtimeDefinition[] = []
  return {
    name: "@vite-hub/realtime/vite",
    enforce: "pre",
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "realtime",
          label: "Realtime",
          list: () => inspectRealtimeDefinitions({
            authority: inspectionAuthority,
            projectRoot: inspectionRoot ?? resolveViteHubProjectRoot(process.cwd(), options),
            serverDirs: inspectionServerDirs,
            contributed: inspectionContributed,
          }),
        }],
      }),
    },
    async config(config, environment) {
      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), options)
      const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      inspectionRoot = root
      inspectionServerDirs = serverDirs
      const discovered = discoverRealtimeDefinitions(root, serverDirs)
      // SAFETY: Vite's config contract exposes Nitro options through this optional property.
      const nitro = { ...(config as { nitro?: NitroConfig }).nitro }
      const deploymentPreset = resolveHost({ nitro })
      const provider = getHostingProvider(deploymentPreset)
      const authority = options.authority || "auto"
      const directory = resolve(root, ".vitehub/nitro/realtime")
      // The authority a contribution may rely on. Configurations that fail below have none.
      const available: RealtimeContributionContext["authority"] | undefined
        = authority === "cloudflare" ? (!deploymentPreset || deploymentPreset === "cloudflare" ? "cloudflare" : undefined)
          : authority === "auto" && provider === "cloudflare" ? "cloudflare"
            : authority === "memory" ? (!deploymentPreset || deploymentPreset === "node" ? "memory" : undefined)
              : environment?.command !== "build" ? "memory" : undefined
      const contribution = available && options.contribute
        ? await options.contribute({ authority: available, directory, projectRoot: root, serverDirs })
        : undefined
      const definitions = [
        ...discovered,
        ...(contribution?.definitions ?? [])
          .filter(definition => !discovered.some(entry => entry.name === definition.name))
          .map((definition): DiscoveredRealtimeDefinition => ({ ...definition, source: "contributed" })),
      ]
      inspectionContributed = definitions.filter(definition => definition.source === "contributed")
      if (definitions.length === 0) return

      config.resolve = {
        ...config.resolve,
        dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])],
      }
      // The server must load one Yjs. In development Vite inlines `yjs` for Realtime when the app cannot resolve it,
      // while the Yjs packages that Realtime imports load it natively: two copies break Yjs constructor checks and
      // drop every client edit. Inline the Yjs family together in the Nitro environment.
      const environments = { ...(config as { environments?: Record<string, Record<string, unknown>> }).environments }
      const nitroEnvironment = { ...environments.nitro }
      const nitroResolve = { ...nitroEnvironment.resolve as Record<string, unknown> }
      const noExternal = nitroResolve.noExternal
      if (noExternal !== true) {
        nitroResolve.noExternal = [...(Array.isArray(noExternal) ? noExternal : noExternal ? [noExternal] : []), ...realtimeServerYjsPackages]
        nitroEnvironment.resolve = nitroResolve
        environments.nitro = nitroEnvironment
        ;(config as { environments?: Record<string, Record<string, unknown>> }).environments = environments
      }
      config.define = {
        __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(config.base)),
        ...config.define,
      }

      const registryFile = resolve(directory, "registry.mjs")
      const handlerFile = resolve(directory, "handler.ts")
      await mkdir(directory, { recursive: true })
      await Promise.all([
        writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
        writeFile(handlerFile, [
          `import registry from ${JSON.stringify(moduleSpecifier(handlerFile, registryFile))}`,
          `import { createRealtimeHandler } from ${JSON.stringify(`${importBase}/server`)}`,
          "",
          "export default createRealtimeHandler(registry)",
          "",
        ].join("\n")),
      ])

      if (authority === "cloudflare" && deploymentPreset && deploymentPreset !== "cloudflare") {
        throw realtimeErrorDiagnostics.REALTIME_B0001({ message: `[vitehub] Realtime authority "cloudflare" conflicts with the ${deploymentPreset} deployment preset.` })
      }
      if (authority === "cloudflare" || (authority === "auto" && provider === "cloudflare")) {
        inspectionAuthority = "cloudflare"
        configureCloudflareRealtime(nitro)
      }
      else if (environment?.command === "build" && authority === "auto") {
        throw realtimeErrorDiagnostics.REALTIME_B0002({ message: "[vitehub] Realtime production builds require one room authority. Deploy to Cloudflare Durable Objects or explicitly set realtime.authority to \"memory\" for a single-process server." })
      }
      else if (authority === "memory" && deploymentPreset && deploymentPreset !== "node") {
        throw realtimeErrorDiagnostics.REALTIME_B0003({ message: `[vitehub] Realtime authority "memory" is single-process only and cannot use the ${deploymentPreset} deployment preset.` })
      }
      if (authority === "memory" || (authority === "auto" && environment?.command !== "build" && inspectionAuthority !== "cloudflare")) {
        inspectionAuthority = "memory"
      }
      nitro.features = { ...nitro.features, websocket: true }
      const kit = createNitroServerKit(nitro)
      kit.addHandler({ handler: handlerFile, route: "/api/_vitehub/realtime/**" })
      for (const plugin of contribution?.plugins ?? []) kit.addPlugin(plugin)
      Object.assign(nitro, kit.config)
      ;(config as UserConfig & { nitro?: NitroConfig }).nitro = nitro
    },
  }
}
