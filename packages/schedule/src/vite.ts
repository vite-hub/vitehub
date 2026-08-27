import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, normalize } from "node:path"

import { contributeProviderDeploymentOutput, finalizeProviderDeploymentOutputs, resetProviderDeploymentOutputs, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { collectViteHubProviderImportAliases, createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { getVercelSchedulePath } from "./integrations/vercel.ts"
import { generateProviderOutputsWithinLock, readDefinitionCrons, schedulePackageName } from "./internal/provider-output.ts"
import { createScheduleTargetsContents, SCHEDULE_TARGETS_ID } from "./targets-module.ts"

import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { ScheduleWorkflowRuntime } from "./internal/provider-output.ts"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { DiscoveredScheduleDefinition } from "./types.ts"

const SCHEDULE_VITE_PLUGIN_NAME = "@vite-hub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_TARGETS_ID = `\0${SCHEDULE_TARGETS_ID}`
const registryImportAnchor = ".vitehub/schedule/registry.js"
const generatedNitroSchedulePlugin = ".vitehub/nitro/schedule/plugin.ts"
const generatedNitroRuntimeRegistry = ".vitehub/nitro/schedule/runtime-registry.js"
const generatedNitroStaticRegistry = ".vitehub/nitro/schedule/static-registry.js"
const generatedNitroCloudflareModule = "./.vitehub/nitro/schedule/module.mjs"
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

export interface ScheduleProcessRuntimeOptions {
  concurrency?: number
  driver: "process"
  intervalMs?: number
  prefix?: string
}

export interface ScheduleVitePluginOptions {
  providerOutput?: "auto" | "standalone" | "nitro" | false
  projectRoot?: string
  runtime?: ScheduleProcessRuntimeOptions
}

export interface ScheduleNitroConfigOptions extends ScheduleVitePluginOptions {
  command?: "build" | "serve"
  nitro?: unknown
  root?: string
  /** @internal Framework-resolved server definition directories. */
  serverDirs?: string[]
}

interface InternalScheduleVitePluginOptions extends ScheduleVitePluginOptions {
  importBase?: string
  providerImportAliases?: Record<string, string>
  runtimeImport?: string
}

export interface ScheduleVitePlugin {
  name: string
  [hook: string]: unknown
}

type NitroConfig = Record<string, unknown> & {
  cloudflare?: {
    wrangler?: {
      triggers?: {
        crons?: string[]
      } & Record<string, unknown>
    } & Record<string, unknown>
  } & Record<string, unknown>
  modules?: unknown[]
  plugins?: unknown[]
  vercel?: {
    config?: {
      crons?: Array<{ path: string, schedule: string }>
    } & Record<string, unknown>
  } & Record<string, unknown>
}

interface WorkflowVitePlugin extends Plugin {
  vitehub?: {
    workflow?: {
      prepareScheduleRuntime?: () => Promise<ScheduleWorkflowRuntime | undefined>
    }
  }
}

type ViteConfigWithNitro = UserConfig & {
  nitro?: NitroConfig
}

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

function resolveProcessRuntimeOptions(value: unknown): ScheduleProcessRuntimeOptions | undefined {
  if (value === undefined) return
  if (!isRecord(value) || value.driver !== "process") {
    throw new TypeError("Schedule Process Runtime driver must be \"process\".")
  }
  if (value.prefix !== undefined && typeof value.prefix !== "string") {
    throw new TypeError("Schedule Process Runtime prefix must be a string.")
  }
  if (value.intervalMs !== undefined && (typeof value.intervalMs !== "number" || !Number.isFinite(value.intervalMs) || value.intervalMs <= 0 || value.intervalMs > 60_000)) {
    throw new TypeError("Schedule Process Runtime intervalMs must be a positive number no greater than 60000.")
  }
  if (value.concurrency !== undefined && (typeof value.concurrency !== "number" || !Number.isInteger(value.concurrency) || value.concurrency < 1)) {
    throw new TypeError("Schedule Process Runtime concurrency must be a positive integer.")
  }
  return {
    ...(value.concurrency !== undefined ? { concurrency: value.concurrency } : {}),
    driver: "process",
    ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs } : {}),
    ...(value.prefix !== undefined ? { prefix: value.prefix } : {}),
  }
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const alias of config.resolve.alias) {
    if (typeof alias.find === "string" && typeof alias.replacement === "string") {
      aliases[alias.find] = alias.replacement
    }
  }
  return aliases
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

function cloneNitroConfig(value: unknown): NitroConfig {
  const nitro = isRecord(value) ? { ...value } : {}
  if (Array.isArray(nitro.plugins)) {
    nitro.plugins = [...nitro.plugins]
  }
  if (isRecord(nitro.cloudflare)) {
    const cloudflare = { ...nitro.cloudflare }
    if (isRecord(cloudflare.wrangler)) {
      const wrangler = { ...cloudflare.wrangler }
      if (isRecord(wrangler.triggers)) {
        const triggers = { ...wrangler.triggers }
        if (Array.isArray(triggers.crons)) {
          triggers.crons = triggers.crons.filter((cron): cron is string => typeof cron === "string")
        }
        wrangler.triggers = triggers
      }
      cloudflare.wrangler = wrangler
    }
    nitro.cloudflare = cloudflare
  }
  return nitro as NitroConfig
}

function mergeNitroScheduleConfig(value: unknown, options: { crons: string[], plugin: string, providerWake: boolean }): NitroConfig {
  const nitro = cloneNitroConfig(value)
  nitro.plugins = Array.isArray(nitro.plugins) && nitro.plugins.includes(options.plugin)
    ? nitro.plugins
    : [...(Array.isArray(nitro.plugins) ? nitro.plugins : []), options.plugin]
  if (!options.providerWake) return nitro
  nitro.modules = Array.isArray(nitro.modules) && nitro.modules.includes(generatedNitroCloudflareModule)
    ? nitro.modules
    : [...(Array.isArray(nitro.modules) ? nitro.modules : []), generatedNitroCloudflareModule]
  nitro.cloudflare ||= {}
  nitro.cloudflare.wrangler ||= {}
  const wrangler = nitro.cloudflare.wrangler
  const existingTriggers = isRecord(wrangler.triggers) ? wrangler.triggers : {}
  const existingCrons = Array.isArray(existingTriggers.crons)
    ? existingTriggers.crons.filter((cron): cron is string => typeof cron === "string")
    : []
  wrangler.triggers = {
    ...existingTriggers,
    crons: [...new Set([...existingCrons, ...options.crons])],
  }
  return nitro
}

function mergeNitroVercelCrons(
  value: unknown,
  definitions: DiscoveredScheduleDefinition[],
  crons: Map<string, string>,
): NitroConfig {
  const nitro = cloneNitroConfig(value)
  const vercel = isRecord(nitro.vercel) ? { ...nitro.vercel } : {}
  const config = isRecord(vercel.config) ? { ...vercel.config } : {}
  const generatedPaths = new Set(definitions.map(definition => getVercelSchedulePath(definition.name)))
  const existing = Array.isArray(config.crons)
    ? config.crons.filter(cron => isRecord(cron) && typeof cron.path === "string" && !generatedPaths.has(cron.path))
    : []
  config.crons = [
    ...existing,
    ...definitions.map(definition => ({
      path: getVercelSchedulePath(definition.name),
      schedule: crons.get(definition.name)!,
    })),
  ]
  vercel.config = config
  nitro.vercel = vercel
  return nitro
}

interface RenderNitroSchedulePluginOptions {
  importBase?: string
  pluginFile: string
  processRuntime?: ScheduleProcessRuntimeOptions
  providerDefinitions: DiscoveredScheduleDefinition[]
  providerRegistryFile: string
  runtimeRegistryFile: string
  staticRegistryFile: string
  runtimeImport?: string
}

function renderNitroSchedulePlugin(options: RenderNitroSchedulePluginOptions): string {
  const importBase = options.importBase ?? schedulePackageName
  const providerWake = options.providerDefinitions.length > 0
  const processRuntime = options.processRuntime
  const processDriverOptions = processRuntime
    ? {
        ...(processRuntime.concurrency !== undefined ? { concurrency: processRuntime.concurrency } : {}),
        ...(processRuntime.intervalMs !== undefined ? { intervalMs: processRuntime.intervalMs } : {}),
      }
    : undefined
  const scheduleStoreOptions = processRuntime?.prefix !== undefined ? { prefix: processRuntime.prefix } : {}
  return [
    "import { definePlugin } from 'nitro'",
    ...(providerWake
      ? [
          `import scheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.providerRegistryFile))}`,
          `import { executeCloudflareStaticSchedules } from ${JSON.stringify(options.runtimeImport ?? `${importBase}/runtime/static`)}`,
        ]
      : []),
    ...(processRuntime
      ? [
          `import { createKVRuntimeScheduleStore, createKVScheduleRunStore } from ${JSON.stringify(importBase)}`,
          `import { installScheduleRuntime } from ${JSON.stringify(`${importBase}/runtime/driver`)}`,
          `import { createProcessScheduleWakeDriver } from ${JSON.stringify(`${importBase}/runtime/process`)}`,
          `import runtimeScheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.runtimeRegistryFile))}`,
          `import staticScheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.staticRegistryFile))}`,
        ]
      : []),
    "",
    ...(processRuntime
      ? [
          `const processDriverOptions = ${JSON.stringify(processDriverOptions, null, 2)}`,
          `const scheduleStoreOptions = ${JSON.stringify(scheduleStoreOptions, null, 2)}`,
          "",
        ]
      : []),
    "export default definePlugin((nitroApp) => {",
    ...(providerWake
      ? [
          "  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {",
          "    await executeCloudflareStaticSchedules(event, { registry: scheduleRegistry })",
          "  })",
        ]
      : []),
    ...(processRuntime
      ? [
          "  function captureRuntimeError(error: unknown) {",
          "    let runtimeError: Error",
          "    try {",
          "      runtimeError = error instanceof Error ? error : new Error(String(error))",
          "    }",
          "    catch {",
          "      return",
          "    }",
          "    try {",
          "      console.error('[vitehub:schedule]', runtimeError)",
          "    }",
          "    catch {}",
          "    try {",
          "      nitroApp.captureError?.(runtimeError, { tags: ['vitehub-schedule'] })",
          "    }",
          "    catch {}",
          "  }",
          "  const runtimeInstallation = installScheduleRuntime({",
          "    createDriver: createProcessScheduleWakeDriver(processDriverOptions),",
          "    onError: captureRuntimeError,",
          "    registry: runtimeScheduleRegistry,",
          "    runtimeScheduleStore: createKVRuntimeScheduleStore(scheduleStoreOptions),",
          "    scheduleRunStore: createKVScheduleRunStore(scheduleStoreOptions),",
          "    staticRegistry: staticScheduleRegistry,",
          "  }).then(",
          "    controller => ({ controller }),",
          "    error => {",
          "      captureRuntimeError(error)",
          "      return { error }",
          "    },",
          "  )",
          "  const nodeProcess = globalThis.process",
          "  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']",
          "  let runtimeClose: Promise<void> | undefined",
          "  function removeRuntimeShutdownSignals() {",
          "    for (const signal of shutdownSignals) nodeProcess?.off(signal, closeRuntimeOnSignal)",
          "  }",
          "  function closeRuntime() {",
          "    removeRuntimeShutdownSignals()",
          "    runtimeClose ??= runtimeInstallation.then(async (result) => {",
          "      if ('controller' in result) await result.controller.close()",
          "    })",
          "    return runtimeClose",
          "  }",
          "  function closeRuntimeOnSignal(signal: NodeJS.Signals) {",
          "    void closeRuntime().catch(captureRuntimeError).finally(() => {",
          "      if (nodeProcess) nodeProcess.kill(nodeProcess.pid, signal)",
          "    })",
          "  }",
          "  for (const signal of shutdownSignals) nodeProcess?.prependOnceListener(signal, closeRuntimeOnSignal)",
          "  nitroApp.hooks.hook('request', async () => {",
          "    const result = await runtimeInstallation",
          "    if ('error' in result) throw result.error",
          "  })",
          "  nitroApp.hooks.hook('close', closeRuntime)",
        ]
      : []),
    "})",
    "",
    `export const vitehubScheduleDefinitions = ${JSON.stringify(options.providerDefinitions.map(definition => definition.name))}`,
    "",
  ].join("\n")
}

function renderNitroCloudflareModule(crons: string[]): string {
  return [
    `const crons = ${JSON.stringify(crons)}`,
    "",
    "function dedupeCloudflareCrons(nitro) {",
    "  const wrangler = nitro.options.cloudflare?.wrangler",
    "  if (!wrangler?.triggers || !Array.isArray(wrangler.triggers.crons)) return",
    "  wrangler.triggers.crons = [...new Set(wrangler.triggers.crons.filter((cron) => typeof cron === 'string'))]",
    "}",
    "",
    "export default function vitehubScheduleModule(nitro) {",
    "  nitro.options.cloudflare ??= {}",
    "  nitro.options.cloudflare.wrangler ??= {}",
    "  nitro.options.cloudflare.wrangler.triggers ??= {}",
    "  const existingCrons = Array.isArray(nitro.options.cloudflare.wrangler.triggers.crons) ? nitro.options.cloudflare.wrangler.triggers.crons : []",
    "  nitro.options.cloudflare.wrangler.triggers.crons = [...new Set([...existingCrons, ...crons])]",
    "  nitro.hooks.hook('build:before', dedupeCloudflareCrons)",
    "}",
    "",
  ].join("\n")
}

function renderScheduleRegistryTypes(importBase = schedulePackageName): string {
  return [
    `import type { ScheduleRegistryDefinition } from ${JSON.stringify(importBase)}`,
    "",
    "declare const registry: Record<string, () => Promise<ScheduleRegistryDefinition | { default?: ScheduleRegistryDefinition }>>",
    "export default registry",
    "",
  ].join("\n")
}

interface WriteNitroSchedulePluginOptions {
  crons: string[]
  importBase?: string
  processRuntime?: ScheduleProcessRuntimeOptions
  providerDefinitions: DiscoveredScheduleDefinition[]
  runtimeDefinitions: DiscoveredScheduleDefinition[]
  staticDefinitions: DiscoveredScheduleDefinition[]
  runtimeImport?: string
}

async function writeNitroSchedulePlugin(root: string, options: WriteNitroSchedulePluginOptions): Promise<string> {
  const pluginFile = resolve(root, generatedNitroSchedulePlugin)
  const moduleFile = resolve(root, generatedNitroCloudflareModule)
  const providerRegistryFile = resolve(root, registryImportAnchor)
  const runtimeRegistryFile = resolve(root, generatedNitroRuntimeRegistry)
  const staticRegistryFile = resolve(root, generatedNitroStaticRegistry)
  await mkdir(dirname(pluginFile), { recursive: true })
  const writes: Array<Promise<void>> = [
    writeFile(pluginFile, renderNitroSchedulePlugin({
      importBase: options.importBase,
      pluginFile,
      processRuntime: options.processRuntime,
      providerDefinitions: options.providerDefinitions,
      providerRegistryFile,
      runtimeRegistryFile,
      staticRegistryFile,
      runtimeImport: options.runtimeImport,
    }), "utf8"),
  ]
  if (options.processRuntime) {
    writes.push(writeFile(runtimeRegistryFile, createRuntimeRegistryContents(runtimeRegistryFile, options.runtimeDefinitions), "utf8"))
    writes.push(writeFile(runtimeRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase), "utf8"))
    writes.push(writeFile(staticRegistryFile, createRuntimeRegistryContents(staticRegistryFile, options.staticDefinitions), "utf8"))
    writes.push(writeFile(staticRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase), "utf8"))
  }
  if (options.providerDefinitions.length > 0) {
    await mkdir(dirname(providerRegistryFile), { recursive: true })
    writes.push(writeFile(providerRegistryFile, createRuntimeRegistryContents(providerRegistryFile, options.providerDefinitions), "utf8"))
    writes.push(writeFile(providerRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase), "utf8"))
    writes.push(writeFile(moduleFile, renderNitroCloudflareModule(options.crons), "utf8"))
  }
  await Promise.all(writes)
  return generatedNitroSchedulePlugin
}

function hasServerScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): boolean {
  return definitions.some(definition => definition.runtimeOnly !== true && definition.source === "server-schedules")
}

function hasViteSuffixScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): boolean {
  return definitions.some(definition => definition.runtimeOnly !== true && definition.source === "vite-suffix")
}

function selectNitroScheduleDefinitions(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): DiscoveredScheduleDefinition[] {
  if (options.providerOutput === false || options.providerOutput === "standalone") return []
  const staticDefinitions = definitions.filter(definition => definition.runtimeOnly !== true)
  if (options.providerOutput === "nitro") return staticDefinitions
  return staticDefinitions.filter(definition => definition.source === "server-schedules")
}

function selectStandaloneProviderSource(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): DiscoveredScheduleDefinition["source"] | undefined {
  if (options.providerOutput === "auto" || options.providerOutput === undefined) {
    return hasServerScheduleDefinitions(definitions) ? "vite-suffix" : undefined
  }
}

function shouldInstallNitroSchedulePlugin(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): boolean {
  return selectNitroScheduleDefinitions(definitions, options).length > 0 || options.runtime !== undefined
}

function shouldEmitStandaloneProviderOutput(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): boolean {
  if (options.providerOutput === false || options.providerOutput === "nitro") return false
  if (options.providerOutput === "standalone") return definitions.some(definition => definition.runtimeOnly !== true)
  if (hasServerScheduleDefinitions(definitions)) return hasViteSuffixScheduleDefinitions(definitions)
  return definitions.some(definition => definition.runtimeOnly !== true)
}

export async function createScheduleNitroConfig(options: ScheduleNitroConfigOptions = {}): Promise<NitroConfig | null> {
  const processRuntime = resolveProcessRuntimeOptions(options.runtime)
  const roots = resolveSchedulePluginRoots(options.root || process.cwd(), options)
  const definitions = discoverScheduleDefinitions({
    rootDir: roots.viteRoot,
    serverDirs: options.serverDirs,
    serverRootDir: roots.projectRoot,
  })
  const installNitroPlugin = shouldInstallNitroSchedulePlugin(definitions, options)
  const nitroPreset = isRecord(options.nitro) && typeof options.nitro.preset === "string"
    ? options.nitro.preset
    : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING || ""
  const standaloneProviderSource = selectStandaloneProviderSource(definitions, options)
  const vercelDefinitions = options.command === "build"
    && nitroPreset.startsWith("vercel")
    && (options.runtime === undefined || options.providerOutput === "standalone")
    && shouldEmitStandaloneProviderOutput(definitions, options)
    ? definitions.filter(definition =>
        definition.runtimeOnly !== true
        && (standaloneProviderSource === undefined || definition.source === standaloneProviderSource),
      )
    : []
  if (!installNitroPlugin && !vercelDefinitions.length) return null

  let nitro = options.nitro
  if (vercelDefinitions.length) {
    nitro = mergeNitroVercelCrons(nitro, vercelDefinitions, await readDefinitionCrons(vercelDefinitions))
  }
  if (!installNitroPlugin) return nitro as NitroConfig

  const nitroDefinitions = processRuntime && options.providerOutput !== "nitro" ? [] : selectNitroScheduleDefinitions(definitions, options)
  const crons = options.command === "build"
    ? [...new Set((await readDefinitionCrons(nitroDefinitions)).values())]
    : []
  const nitroDefinitionNames = new Set(nitroDefinitions.map(definition => definition.name))
  const plugin = await writeNitroSchedulePlugin(roots.projectRoot, {
    crons,
    importBase: (options as InternalScheduleVitePluginOptions).importBase,
    processRuntime,
    providerDefinitions: nitroDefinitions,
    runtimeDefinitions: definitions,
    staticDefinitions: definitions.filter(definition =>
      definition.runtimeOnly !== true
      && !nitroDefinitionNames.has(definition.name)
      && !(processRuntime && options.providerOutput === "standalone")
    ),
    runtimeImport: (options as InternalScheduleVitePluginOptions).runtimeImport,
  })
  return mergeNitroScheduleConfig(nitro, {
    crons,
    plugin,
    providerWake: nitroDefinitions.length > 0,
  })
}

export function hubSchedule(options: ScheduleVitePluginOptions = {}): ScheduleVitePlugin {
  const internalOptions = options as InternalScheduleVitePluginOptions
  let resolved: ResolvedConfig | undefined
  let emitStandaloneProviderOutput = true
  let projectRoot: string | undefined
  let providerOutput: ProviderOutputCatalog | undefined
  let standaloneProviderSource: DiscoveredScheduleDefinition["source"] | undefined
  let serverDirs: string[] | undefined
  let viteRoot: string | undefined

  function discoverViteSchedules() {
    if (!projectRoot || !viteRoot) {
      return []
    }

    return discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRoot,
      serverDirs,
      serverRootDir: projectRoot,
    })
  }

  function discoverRegistrySchedules() {
    if (!projectRoot || !viteRoot) {
      return []
    }

    return discoverScheduleDefinitions({
      rootDir: viteRoot,
      serverDirs,
      serverRootDir: projectRoot,
    })
  }

  function createRegistryContents() {
    const definitions = discoverRegistrySchedules()
    const registryImport = projectRoot ? resolve(projectRoot, registryImportAnchor) : registryImportAnchor
    return createRuntimeRegistryContents(registryImport, definitions)
  }

  function createTargetsContents() {
    return createScheduleTargetsContents(discoverViteSchedules(), { types: false })
  }

  const plugin: Plugin = {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    enforce: "pre",
    async config(config, env) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const roots = resolveSchedulePluginRoots(config.root || process.cwd(), options)
      const definitions = discoverScheduleDefinitions({
        rootDir: roots.viteRoot,
        serverDirs,
        serverRootDir: roots.projectRoot,
      })
      emitStandaloneProviderOutput = (options.runtime === undefined || options.providerOutput === "standalone") && shouldEmitStandaloneProviderOutput(definitions, options)
      standaloneProviderSource = selectStandaloneProviderSource(definitions, options)
      const nitro = await createScheduleNitroConfig({
        ...options,
        command: env.command,
        nitro: (config as { nitro?: unknown }).nitro,
        root: config.root || process.cwd(),
        serverDirs,
      })
      if (!nitro) return null
      ;(config as ViteConfigWithNitro).nitro = nitro
    },
    configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      const roots = resolveSchedulePluginRoots(config.root, options)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    handleHotUpdate(context) {
      const file = normalize(context.file).replace(/\\/g, "/")
      const scheduleRoots = (serverDirs ?? [resolve(projectRoot ?? resolved?.root ?? context.server.config.root, "server")])
        .map(directory => `${resolve(directory, "schedules").replace(/\\/g, "/")}/`)
      const serverSchedule = scheduleRoots.some(directory =>
        file.startsWith(directory) && /\.(?:c|m)?[jt]s$/i.test(file.slice(directory.length)),
      )
      if (!/\.schedule\.(?:c|m)?[jt]s$/i.test(file) && !serverSchedule) {
        return
      }

      const registryModule = context.server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_REGISTRY_ID)
      if (registryModule) {
        context.server.moduleGraph.invalidateModule(registryModule)
      }
      const targetsModule = context.server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_TARGETS_ID)
      if (targetsModule) {
        context.server.moduleGraph.invalidateModule(targetsModule)
      }
    },
    resolveId(id) {
      if (id === SCHEDULE_REGISTRY_ID) {
        return RESOLVED_SCHEDULE_REGISTRY_ID
      }
      if (id === SCHEDULE_TARGETS_ID) {
        return RESOLVED_SCHEDULE_TARGETS_ID
      }
    },
    load(id) {
      if (id === RESOLVED_SCHEDULE_REGISTRY_ID) {
        return createRegistryContents()
      }
      if (id === RESOLVED_SCHEDULE_TARGETS_ID) {
        return createTargetsContents()
      }
    },
    async buildEnd(error) {
      if (error) {
        await resetProviderDeploymentOutputs(providerOutput)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      const config = resolved
      const rootDir = projectRoot ?? config.root
      const prepareWorkflow = ((config.plugins ?? []) as WorkflowVitePlugin[])
        .find(candidate => candidate.vitehub?.workflow?.prepareScheduleRuntime)
        ?.vitehub?.workflow?.prepareScheduleRuntime
      contributeProviderDeploymentOutput(providerOutput, {
        owner: "schedule",
        rootDir,
        write: async ({ signal }) => {
          const workflow = await prepareWorkflow?.()
          const contributedAliases = await collectViteHubProviderImportAliases((config.plugins ?? []) as Array<Plugin & ViteHubProviderImportContributor>)
          signal.throwIfAborted()
          await generateProviderOutputsWithinLock({
            bundleAlias: {
              ...resolveStringAliases(config),
              ...contributedAliases,
              ...internalOptions.providerImportAliases,
              ...workflow?.bundleAlias,
            },
            ...(workflow ? { bundleExternal: ["@vitejs/devtools-core", "@vitejs/devtools-kit", "@vitejs/devtools-rolldown"] } : {}),
            clientOutDir: resolve(config.root, config.build.outDir),
            definitions: emitStandaloneProviderOutput ? discoverRegistrySchedules() : [],
            rootDir,
            runtimeImport: internalOptions.runtimeImport,
            source: standaloneProviderSource,
            workflow,
          })
        },
      })
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }

  return plugin as ScheduleVitePlugin
}
