import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve, normalize } from "node:path"

import { createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { collectScheduleContributions } from "./contributions.ts"
import { discoverScheduleDefinitions } from "./discovery.ts"
import { inspectScheduleDefinitions } from "./inspect.ts"
import { readDefinitionCrons, readRuntimeDefinitionCrons } from "./internal/cron.ts"
import { createScheduleNitroModule, isScheduleNitroModule, schedulePackageName } from "./internal/nitro.ts"
import { renderScheduleRegistryModule } from "./internal/registry-module.ts"
import { scheduleDevRuntimeRoute } from "./dev.ts"
import { registerScheduleDevEndpoint } from "./vite-dev.ts"

import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { CollectedScheduleContribution } from "./contributions.ts"
import type { DiscoveredScheduleDefinition } from "./types.ts"

export { collectScheduleContributions } from "./contributions.ts"
export type {
  CollectedScheduleContribution,
  ScheduleContributingPlugin,
  ScheduleContribution,
  ScheduleContributionContext,
  ScheduleContributionFactory,
} from "./contributions.ts"
export { contributedScheduleSource, discoverScheduleDefinitions, type ScheduleDiscoveryOptions } from "./discovery.ts"
export { inspectScheduleDefinitions, type ScheduleInspectionOptions, scheduleConsoleSection } from "./inspect.ts"

export async function readScheduleDefinitionCrons(
  definitions: DiscoveredScheduleDefinition[],
): Promise<Map<string, string>> {
  return await readRuntimeDefinitionCrons(definitions)
}

const SCHEDULE_VITE_PLUGIN_NAME = "@vite-hub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const generatedNitroDevHandlerDirectory = ".vitehub/nitro/schedule/dev-handlers"
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

// The Nitro dev handler imports the registry in Nitro's own environment graph, so invalidate it there too.
function invalidateScheduleRegistry(server: ViteDevServer): void {
  const registry = server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_REGISTRY_ID)
  if (registry) server.moduleGraph.invalidateModule(registry)
  for (const environment of Object.values(server.environments ?? {})) {
    const module = environment.moduleGraph.getModuleById(RESOLVED_SCHEDULE_REGISTRY_ID)
    if (!module) continue
    environment.moduleGraph.invalidateModule(module)
    if (environment.config.consumer === "server") environment.hot.send({ type: "full-reload" })
  }
}

export interface ScheduleVitePluginOptions {
  projectRoot?: string
}

export interface ScheduleNitroConfigOptions extends ScheduleVitePluginOptions {
  command?: "build" | "serve"
  nitro?: unknown
  /** Vite plugins that can contribute Schedule Definitions through `vitehub.schedules`. */
  plugins?: readonly unknown[]
  root?: string
  /** @internal Framework-resolved server definition directories. */
  serverDirs?: string[]
}

interface InternalScheduleNitroConfigOptions extends ScheduleNitroConfigOptions {
  /** Contributions that the Vite plugin already collected, so factories run once per config pass. */
  contributions?: readonly CollectedScheduleContribution[]
}

interface InternalScheduleVitePluginOptions extends ScheduleVitePluginOptions {
  importBase?: string
  runtimeImport?: string
}

export interface ScheduleVitePlugin {
  name: string
  [hook: string]: unknown
  vitehub?: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata
}

type NitroConfig = Record<string, unknown>

function resolveSchedulePluginRoots(root: string, options: Pick<ScheduleVitePluginOptions, "projectRoot"> = {}) {
  const resolvedViteRoot = resolve(root)
  const resolvedProjectRoot = resolveViteHubProjectRoot(resolvedViteRoot, {
    projectRoot: options.projectRoot,
  })
  return { projectRoot: resolvedProjectRoot, viteRoot: resolvedViteRoot }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function cloneNitroConfig(value: unknown): NitroConfig {
  return isRecord(value) ? { ...value } : {}
}

async function addNitroScheduleDevHandler(value: unknown, roots: ReturnType<typeof resolveSchedulePluginRoots>, serverId: string, importBase?: string): Promise<NitroConfig> {
  const handler = resolve(roots.projectRoot, generatedNitroDevHandlerDirectory, `${serverId}.ts`)
  await mkdir(dirname(handler), { recursive: true })
  // The Static Schedule registry is a Vite virtual module, so the Nitro dev environment loads it with the app code.
  const contents = renderViteHubNitroDevHandler({ context: { rootDir: roots.viteRoot, serverId }, contextModules: { registry: SCHEDULE_REGISTRY_ID }, export: "handleScheduleDevRequest", module: `${importBase ?? schedulePackageName}/runtime/dev` })
  if (!existsSync(handler) || await readFile(handler, "utf8") !== contents) await writeFile(handler, contents, "utf8")
  const nitro = cloneNitroConfig(value)
  if (Array.isArray(nitro.handlers) && nitro.handlers.some(entry => isRecord(entry) && entry.route === scheduleDevRuntimeRoute)) return nitro
  const kit = createNitroServerKit(nitro)
  kit.addHandler({ handler, route: scheduleDevRuntimeRoute })
  return kit.config
}

/**
 * Registers each Static Schedule Definition as a Nitro task in `scheduledTasks` for `vite build`.
 * Nitro fires the tasks on Node, Cloudflare, and Vercel. ViteHub adds a Netlify scheduled function
 * and Deno Deploy `Deno.cron` calls, because Nitro has no scheduler for those presets.
 */
export async function createScheduleNitroConfig(options: ScheduleNitroConfigOptions = {}): Promise<NitroConfig | null> {
  if (options.command !== "build") return null
  const roots = resolveSchedulePluginRoots(options.root || process.cwd(), options)
  // SAFETY: Only `hubSchedule()` passes the internal `contributions` field; public callers leave it undefined.
  const contributions = (options as InternalScheduleNitroConfigOptions).contributions
    ?? await collectScheduleContributions(options.plugins, { projectRoot: roots.projectRoot, root: roots.viteRoot, serverDirs: options.serverDirs })
  const definitions = discoverScheduleDefinitions({
    contributions,
    rootDir: roots.viteRoot,
    serverDirs: options.serverDirs,
    serverRootDir: roots.projectRoot,
  })
  if (!definitions.length) return null
  const crons = await readDefinitionCrons(definitions)
  // SAFETY: Only `hubSchedule()` passes the internal import fields; public callers leave them undefined.
  const internal = options as InternalScheduleVitePluginOptions
  const module = await createScheduleNitroModule({
    definitions,
    entries: definitions.map(definition => ({ cron: crons.get(definition.name)!, name: definition.name })),
    projectRoot: roots.projectRoot,
    runtimeImport: internal.runtimeImport ?? `${internal.importBase ?? schedulePackageName}/runtime/static`,
  })
  const nitro = cloneNitroConfig(options.nitro)
  const modules = Array.isArray(nitro.modules) ? nitro.modules.filter(entry => !isScheduleNitroModule(entry)) : []
  return { ...nitro, modules: [...modules, module] }
}

export function hubSchedule(options: ScheduleVitePluginOptions = {}): ScheduleVitePlugin {
  const internalOptions = options as InternalScheduleVitePluginOptions
  const devServerId = globalThis.crypto.randomUUID()
  let closeDevEndpoint: (() => Promise<void>) | undefined
  let resolved: ResolvedConfig | undefined
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let viteRoot: string | undefined
  let contributions: CollectedScheduleContribution[] = []

  async function collectPluginScheduleContributions(plugins: readonly unknown[] | undefined, roots: ReturnType<typeof resolveSchedulePluginRoots>) {
    return await collectScheduleContributions(plugins, { projectRoot: roots.projectRoot, root: roots.viteRoot, serverDirs })
  }

  function discoverRegistrySchedules() {
    if (!projectRoot || !viteRoot) {
      return []
    }

    return discoverScheduleDefinitions({
      contributions,
      rootDir: viteRoot,
      serverDirs,
      serverRootDir: projectRoot,
    })
  }

  const plugin: Plugin = {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    enforce: "pre",
    async config(config, env) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const roots = resolveSchedulePluginRoots(config.root || process.cwd(), options)
      contributions = await collectPluginScheduleContributions(config.plugins, roots)
      const currentNitro = (config as { nitro?: unknown }).nitro
      if (env.command === "serve") {
        ;(config as { nitro?: unknown }).nitro = await addNitroScheduleDevHandler(currentNitro, roots, devServerId, internalOptions.importBase)
        return
      }
      const nitro = await createScheduleNitroConfig({
        ...options,
        command: env.command,
        contributions,
        nitro: currentNitro,
        root: config.root || process.cwd(),
        serverDirs,
      } as InternalScheduleNitroConfigOptions)
      if (nitro) (config as { nitro?: unknown }).nitro = nitro
    },
    async configureServer(server) {
      closeDevEndpoint = await registerScheduleDevEndpoint(server, {
        serverId: devServerId,
        nitroBaseURL: () => {
          const baseURL = (resolved as (ResolvedConfig & { nitro?: { baseURL?: unknown } }) | undefined)?.nitro?.baseURL
          return typeof baseURL === "string" ? baseURL : process.env.NITRO_APP_BASE_URL
        },
      })
    },
    async configResolved(config) {
      resolved = config
      const roots = resolveSchedulePluginRoots(config.root, options)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
      // The resolved list includes plugins that other plugins add after the `config` hook.
      contributions = await collectPluginScheduleContributions(config.plugins, roots)
      if (config.command !== "build") return
      // SAFETY: Nitro integrations attach their generated config to the resolved Vite config at runtime.
      const configWithNitro = config as ResolvedConfig & { nitro?: unknown }
      const nitro = await createScheduleNitroConfig({
        ...options,
        command: config.command,
        contributions,
        nitro: configWithNitro.nitro,
        root: config.root,
        serverDirs,
      } as InternalScheduleNitroConfigOptions)
      if (nitro) configWithNitro.nitro = nitro
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      const file = normalize(context.file).replace(/\\/g, "/")
      const scheduleRoots = (serverDirs ?? [resolve(projectRoot ?? resolved?.root ?? context.server.config.root, "server")])
        .map(directory => `${resolve(directory, "schedules").replace(/\\/g, "/")}/`)
      const serverSchedule = scheduleRoots.some(directory =>
        file.startsWith(directory) && /\.(?:c|m)?[jt]s$/i.test(file.slice(directory.length)),
      )
      const contributedSchedule = contributions.some(contribution => normalize(contribution.definition.module).replace(/\\/g, "/") === file)
      if (!/\.schedule\.(?:c|m)?[jt]s$/i.test(file) && !serverSchedule && !contributedSchedule) {
        return
      }

      invalidateScheduleRegistry(context.server)
    },
    resolveId(id) {
      if (id === SCHEDULE_REGISTRY_ID) {
        return RESOLVED_SCHEDULE_REGISTRY_ID
      }
    },
    load(id) {
      if (id === RESOLVED_SCHEDULE_REGISTRY_ID) {
        return renderScheduleRegistryModule(discoverRegistrySchedules())
      }
    },
    async closeBundle() {
      await closeDevEndpoint?.()
      closeDevEndpoint = undefined
    },
  }

  // SAFETY: The implementation above supplies Vite's plugin hooks plus ViteHub's intentionally loose public hook index.
  const inspectable = plugin as ScheduleVitePlugin
  inspectable.vitehub = {
    cli: async () => {
      const { createScheduleCliContributor } = await import(/* @vite-ignore */ "./cli.js")
      return createScheduleCliContributor()
    },
    inspect: () => ({
      definitions: [{
        kind: "schedule",
        label: "Schedules",
        list: () => {
          const roots = resolveSchedulePluginRoots(viteRoot ?? process.cwd(), options)
          return inspectScheduleDefinitions({ plugins: resolved?.plugins, projectRoot: roots.projectRoot, rootDir: roots.viteRoot, serverDirs, serverRootDir: roots.projectRoot })
        },
      }],
    }),
  } satisfies ViteHubInspectionPluginMetadata & ViteHubCliPluginMetadata
  return inspectable
}
