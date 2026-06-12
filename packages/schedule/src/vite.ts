import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, normalize } from "node:path"

import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { generateProviderOutputs, readDefinitionCrons, schedulePackageName } from "./internal/provider-output.ts"
import { createScheduleTargetsContents, SCHEDULE_TARGETS_ID } from "./targets-module.ts"

import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { DiscoveredScheduleDefinition } from "./types.ts"

const SCHEDULE_VITE_PLUGIN_NAME = "@vite-hub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_TARGETS_ID = `\0${SCHEDULE_TARGETS_ID}`
const registryImportAnchor = ".vitehub/schedule/registry.js"
const generatedNitroCloudflarePlugin = "server/plugins/vitehub-schedule.ts"
const generatedNitroCloudflareModule = "server/modules/vitehub-schedule.ts"
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

export interface ScheduleVitePluginOptions {
  providerOutput?: "auto" | "standalone" | "nitro" | false
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
  plugins?: unknown[]
}

type ViteConfigWithNitro = UserConfig & {
  nitro?: NitroConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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

function mergeNitroScheduleConfig(value: unknown, options: { crons: string[], plugin: string }): NitroConfig {
  const nitro = cloneNitroConfig(value)
  nitro.plugins = Array.isArray(nitro.plugins) && nitro.plugins.includes(options.plugin)
    ? nitro.plugins
    : [...(Array.isArray(nitro.plugins) ? nitro.plugins : []), options.plugin]
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

function renderNitroCloudflarePlugin(definitions: DiscoveredScheduleDefinition[], pluginFile: string, registryFile: string): string {
  const registryImport = moduleImportSpecifier(pluginFile, registryFile)
  const scheduleRuntimeImport = "@vite-hub/schedule/runtime/static"
  return [
    "import { definePlugin } from 'nitro'",
    "import type { ScheduleDefinition } from '@vite-hub/schedule'",
    `import scheduleRegistry from ${JSON.stringify(registryImport)}`,
    `import { executeStaticSchedule } from ${JSON.stringify(scheduleRuntimeImport)}`,
    "",
    "interface NitroCloudflareScheduledEvent {",
    "  controller: {",
    "    cron: string",
    "    scheduledTime: number | string | Date",
    "  }",
    "}",
    "",
    "type LoadedScheduleModule = ScheduleDefinition | { default?: ScheduleDefinition }",
    "",
    "function unwrapScheduleDefinition(loaded: LoadedScheduleModule): ScheduleDefinition | undefined {",
    "  if (typeof loaded === 'object' && loaded !== null && 'default' in loaded) return loaded.default",
    "  return loaded as ScheduleDefinition",
    "}",
    "",
    "async function loadScheduleDefinition(name: string): Promise<ScheduleDefinition | undefined> {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader() as LoadedScheduleModule",
    "  return unwrapScheduleDefinition(loaded)",
    "}",
    "",
    "async function runMatchingSchedules(event: NitroCloudflareScheduledEvent): Promise<void> {",
    "  const cron = event.controller.cron",
    "  const scheduledAt = new Date(event.controller.scheduledTime)",
    "  const tasks = Object.entries(scheduleRegistry).map(async ([name]) => {",
    "    const definition = await loadScheduleDefinition(name)",
    "    if (!definition || definition.cron !== cron) return",
    "    await executeStaticSchedule({ cron, definition, name, scheduledAt })",
    "  })",
    "  await Promise.all(tasks)",
    "}",
    "",
    "export default definePlugin((nitroApp) => {",
    "  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {",
    "    await runMatchingSchedules(event)",
    "  })",
    "})",
    "",
    `export const vitehubScheduleDefinitions = ${JSON.stringify(definitions.map(definition => definition.name))}`,
    "",
  ].join("\n")
}

function renderNitroCloudflareModule(crons: string[]): string {
  return [
    "import type { Nitro } from 'nitro/types'",
    "",
    `const crons = ${JSON.stringify(crons)}`,
    "",
    "interface WranglerScheduleConfig {",
    "  triggers?: {",
    "    crons?: string[]",
    "    [key: string]: unknown",
    "  }",
    "  [key: string]: unknown",
    "}",
    "",
    "function getWranglerConfig(nitro: Nitro): WranglerScheduleConfig {",
    "  nitro.options.cloudflare ??= {}",
    "  const cloudflare = nitro.options.cloudflare as { wrangler?: WranglerScheduleConfig }",
    "  cloudflare.wrangler ??= {}",
    "  return cloudflare.wrangler",
    "}",
    "",
    "export default function vitehubScheduleModule(nitro: Nitro): void {",
    "  const wrangler = getWranglerConfig(nitro)",
    "  wrangler.triggers ??= {}",
    "  const existingCrons = Array.isArray(wrangler.triggers.crons) ? wrangler.triggers.crons : []",
    "  wrangler.triggers.crons = [...new Set([...existingCrons, ...crons])]",
    "}",
    "",
  ].join("\n")
}

function renderScheduleRegistryTypes(): string {
  return [
    "import type { ScheduleDefinition } from '@vite-hub/schedule'",
    "",
    "declare const registry: Record<string, () => Promise<ScheduleDefinition | { default?: ScheduleDefinition }>>",
    "export default registry",
    "",
  ].join("\n")
}

async function writeNitroCloudflarePlugin(root: string, definitions: DiscoveredScheduleDefinition[], crons: string[]): Promise<string> {
  const pluginFile = resolve(root, generatedNitroCloudflarePlugin)
  const moduleFile = resolve(root, generatedNitroCloudflareModule)
  const registryFile = resolve(root, registryImportAnchor)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(dirname(moduleFile), { recursive: true }),
    mkdir(dirname(registryFile), { recursive: true }),
  ])
  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")
  await writeFile(registryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(), "utf8")
  await writeFile(pluginFile, renderNitroCloudflarePlugin(definitions, pluginFile, registryFile), "utf8")
  await writeFile(moduleFile, renderNitroCloudflareModule(crons), "utf8")
  return generatedNitroCloudflarePlugin
}

function hasServerScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): boolean {
  return definitions.some(definition => definition.source === "server-schedules")
}

function shouldInstallNitroSchedulePlugin(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): boolean {
  if (options.providerOutput === false || options.providerOutput === "standalone") return false
  if (options.providerOutput === "nitro") return definitions.length > 0
  return hasServerScheduleDefinitions(definitions)
}

function shouldEmitStandaloneProviderOutput(definitions: DiscoveredScheduleDefinition[], options: ScheduleVitePluginOptions): boolean {
  if (options.providerOutput === false || options.providerOutput === "nitro") return false
  if (options.providerOutput === "standalone") return true
  return !hasServerScheduleDefinitions(definitions)
}

export function hubSchedule(options: ScheduleVitePluginOptions = {}): ScheduleVitePlugin {
  let resolved: ResolvedConfig | undefined
  let emitStandaloneProviderOutput = true

  function discoverViteSchedules() {
    if (!resolved) {
      return []
    }

    return discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: resolved.root,
    })
  }

  function createRegistryContents() {
    const definitions = discoverViteSchedules()
    const registryImport = resolved ? resolve(resolved.root, registryImportAnchor) : registryImportAnchor
    return createRuntimeRegistryContents(registryImport, definitions)
  }

  function createTargetsContents() {
    return createScheduleTargetsContents(discoverViteSchedules(), { types: false })
  }

  const plugin: Plugin = {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    async config(config, env) {
      const root = resolve(config.root || process.cwd())
      const definitions = discoverScheduleDefinitions({ rootDir: root })
      emitStandaloneProviderOutput = shouldEmitStandaloneProviderOutput(definitions, options)
      if (definitions.length === 0) {
        return null
      }
      if (!shouldInstallNitroSchedulePlugin(definitions, options)) {
        return null
      }
      const crons = env.command === "build"
        ? [...new Set((await readDefinitionCrons(definitions)).values())]
        : []
      const plugin = await writeNitroCloudflarePlugin(root, definitions, crons)
      const viteConfig: ViteConfigWithNitro = {
        nitro: mergeNitroScheduleConfig((config as { nitro?: unknown }).nitro, { crons, plugin }),
      }
      return viteConfig
    },
    configResolved(config) {
      resolved = config
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
      if (!/\.schedule\.(?:c|m)?[jt]s$/i.test(file) && !/\/server\/schedules\/.*\.(?:c|m)?[jt]s$/i.test(file)) {
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
    async closeBundle() {
      if (!resolved || !emitStandaloneProviderOutput || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        bundleAlias: resolveStringAliases(resolved),
        clientOutDir: resolved.build.outDir,
        rootDir: resolved.root,
      })
    },
  }

  return plugin as unknown as ScheduleVitePlugin
}
