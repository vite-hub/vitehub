import { randomUUID } from "node:crypto"
import { ownModule } from "@vite-hub/internal/build/paths"
import { rm } from "node:fs/promises"
import { dirname, relative, resolve, normalize } from "node:path"

import { contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { encodeProviderOutputAliases } from "@vite-hub/internal/build/bundle-options"
import { providerOutputAliasSources, removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { createRuntimeRegistryContents, writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { collectViteHubProviderImportAliases, createNoExternalMerger, createProviderOutputEnvironmentOwner, hasNitroConfigContext, isServerEnvironment, prepareViteHubProviderSources, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { resolveHost } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { collectScheduleContributions } from "./contributions.ts"
import { discoverScheduleDefinitions, discoverStartableScheduleDefinitions, isServerScheduleDefinition } from "./discovery.ts"
import { inspectScheduleDefinitions } from "./inspect.ts"
import { getVercelSchedulePath } from "./integrations/vercel.ts"
import { generateProviderOutputsWithinLock, netlifyScheduleFunctionNames, readDefinitionCrons, readRuntimeDefinitionCrons, readStaticScheduleTiming, readTimeZoneCrons, schedulePackageName } from "./internal/provider-output.ts"
import { renderScheduleRegistryModule } from "./internal/registry-module.ts"

import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { ScheduleCronOverrides, ScheduleTimeZoneCrons, ScheduleWorkflowRuntime } from "./internal/provider-output.ts"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { CollectedScheduleContribution } from "./contributions.ts"
import type { DiscoveredScheduleDefinition } from "./types.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

export { collectScheduleContributions } from "./contributions.ts"
export type {
  CollectedScheduleContribution,
  ScheduleContributingPlugin,
  ScheduleContribution,
  ScheduleContributionContext,
  ScheduleContributionFactory,
} from "./contributions.ts"
export { contributedScheduleSource, discoverScheduleDefinitions, discoverStartableScheduleDefinitions, type ScheduleDiscoveryOptions } from "./discovery.ts"
export { inspectScheduleDefinitions, type ScheduleInspectionOptions, scheduleConsoleSection } from "./inspect.ts"

export async function readScheduleDefinitionCrons(
  definitions: DiscoveredScheduleDefinition[],
): Promise<Map<string, string>> {
  return await readRuntimeDefinitionCrons(definitions)
}

const SCHEDULE_VITE_PLUGIN_NAME = "@vite-hub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const generatedNitroSchedulePlugin = ".vitehub/nitro/schedule/plugin.ts"
const generatedNitroProviderRegistry = ".vitehub/nitro/schedule/provider-registry.js"
const generatedNitroStaticRegistry = ".vitehub/nitro/schedule/static-registry.js"
const generatedNitroStartedRegistry = ".vitehub/nitro/schedule/started-registry.js"
const defaultCatchUpMs = 60 * 60 * 1000
const generatedNitroScheduleModule = "./.vitehub/nitro/schedule/module.mjs"
const generatedNitroNetlifyEntry = ".vitehub/nitro/schedule/netlify-entry.mjs"
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

export interface ScheduleProcessRuntimeOptions {
  catchUpMs?: number
  concurrency?: number
  driver: "process"
  intervalMs?: number
  /** Milliseconds that a server holds an occurrence after it stops, before another server may run it. Defaults to `60000`. */
  leaseTtlMs?: number
  prefix?: string
}

export interface ScheduleOptions {
  /**
   * Cron per Schedule name for this build's host, in place of the cron that the Schedule declares. Set it in the
   * host's build config, such as `{ cleanup: "0 0 * * *" }` for Vercel Hobby, which runs cron jobs at most once a day.
   */
  cron?: Readonly<Record<string, string>>
  providerOutput?: "auto" | "standalone" | "nitro" | false
  projectRoot?: string
  runtime?: ScheduleProcessRuntimeOptions
}

export interface ScheduleNitroConfigOptions extends ScheduleOptions {
  command?: "build" | "serve"
  /** @internal Resolve generated Nitro registrations from the ViteHub project root. */
  nitroOwnsPaths?: boolean
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
  /** The module that exports the app's `databases`, when the app has the Database plugin. The Process Runtime claims occurrences there. */
  leaseDatabaseImport?: string
  /** Set in Vite's `config` hook, where plugins added later can still contribute the Schedule that `cron` names. */
  preliminary?: boolean
}

interface InternalScheduleVitePluginOptions extends ScheduleOptions {
  /** The module that exports the app's `databases`. Defaults to `@vite-hub/database/drizzle`. */
  databaseImport?: string
  importBase?: string
  providerImportAliases?: Record<string, string>
  runtimeImport?: string
}

export interface ScheduleVitePlugin {
  name: string
  [hook: string]: unknown
  vitehub?: ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & { operations?: readonly OperationContributionEntry[] }
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
      prepareScheduleRuntime?: (artifactDir?: string) => Promise<ScheduleWorkflowRuntime | undefined>
    }
  }
}

type ViteConfigWithNitro = Omit<UserConfig, "nitro"> & {
  nitro?: NitroConfig
}

function resolveSchedulePluginRoots(root: string, options: Pick<ScheduleOptions, "projectRoot"> = {}) {
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
    throw scheduleErrorDiagnostics.SCHEDULE_B0001({ message: "Schedule Process Runtime driver must be \"process\"." })
  }
  if (value.prefix !== undefined && typeof value.prefix !== "string") {
    throw scheduleErrorDiagnostics.SCHEDULE_B0002({ message: "Schedule Process Runtime prefix must be a string." })
  }
  if (value.catchUpMs !== undefined && (typeof value.catchUpMs !== "number" || !Number.isFinite(value.catchUpMs) || value.catchUpMs < 0)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0005({ message: "Schedule Process Runtime catchUpMs must be a non-negative number." })
  }
  if (value.intervalMs !== undefined && (typeof value.intervalMs !== "number" || !Number.isFinite(value.intervalMs) || value.intervalMs <= 0 || value.intervalMs > 60_000)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0003({ message: "Schedule Process Runtime intervalMs must be a positive number no greater than 60000." })
  }
  if (value.concurrency !== undefined && (typeof value.concurrency !== "number" || !Number.isInteger(value.concurrency) || value.concurrency < 1)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0004({ message: "Schedule Process Runtime concurrency must be a positive integer." })
  }
  if (value.leaseTtlMs !== undefined && (typeof value.leaseTtlMs !== "number" || !Number.isFinite(value.leaseTtlMs) || value.leaseTtlMs <= 0)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0009({ message: "Schedule Process Runtime leaseTtlMs must be a positive number." })
  }
  return {
    ...(value.catchUpMs !== undefined ? { catchUpMs: value.catchUpMs } : {}),
    ...(value.concurrency !== undefined ? { concurrency: value.concurrency } : {}),
    driver: "process",
    ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs } : {}),
    ...(value.leaseTtlMs !== undefined ? { leaseTtlMs: value.leaseTtlMs } : {}),
    ...(value.prefix !== undefined ? { prefix: value.prefix } : {}),
  }
}

const databaseVitePluginName = "@vite-hub/database/vite"

function hasVitePlugin(plugins: readonly unknown[] | undefined, name: string): boolean {
  return (plugins ?? []).some(plugin => Array.isArray(plugin) ? hasVitePlugin(plugin, name) : isRecord(plugin) && plugin.name === name)
}

/**
 * Checks the build's `cron` map. `definitions` is the final Schedule set, or `undefined` while plugins can still
 * contribute Schedules. The Process Runtime owns Static Schedule wakes unless `providerOutput` is `nitro` or `standalone`.
 */
function resolveCronOverrides(
  value: unknown,
  definitions: DiscoveredScheduleDefinition[] | undefined,
  options: Pick<ScheduleOptions, "providerOutput" | "runtime">,
): ScheduleCronOverrides | undefined {
  if (value === undefined) return
  if (!isRecord(value) || Array.isArray(value)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0008({ message: "Schedule `cron` must map Schedule names to cron strings, such as `{ cleanup: \"0 0 * * *\" }`." })
  }
  const names = definitions && new Set(definitions.map(definition => definition.name))
  const overrides: Record<string, string> = {}
  for (const [name, cron] of Object.entries(value)) {
    if (typeof cron !== "string" || !cron.trim()) {
      throw scheduleErrorDiagnostics.SCHEDULE_B0008({ message: `Schedule \`cron\` gives "${name}" a value that is not a cron string.` })
    }
    if (names && !names.has(name)) {
      throw scheduleErrorDiagnostics.SCHEDULE_B0008({ message: `Schedule \`cron\` names "${name}", but no Schedule has that name. Schedules: ${[...names].map(entry => `"${entry}"`).join(", ") || "none"}.` })
    }
    overrides[name] = cron
  }
  const processOwnsWakes = options.runtime !== undefined && options.providerOutput !== "nitro" && options.providerOutput !== "standalone"
  if (processOwnsWakes && Object.keys(overrides).length) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0008({ message: "Schedule `cron` sets the cron of host cron output, but the Process Runtime runs each Schedule on the cron it declares. Change the cron in the Schedule, or let the host wake Schedules with `providerOutput: \"nitro\"` or `\"standalone\"`." })
  }
  return overrides
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  return encodeProviderOutputAliases(config.resolve.alias)
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

function isGeneratedNitroRegistration(value: unknown, generatedPath: string): boolean {
  const suffix = generatedPath.replace(/^\.\//, "")
  return typeof value === "string"
    && (value === generatedPath || value.replaceAll("\\", "/").endsWith(`/${suffix}`))
}

function mergeNitroScheduleConfig(value: unknown, options: { crons: string[], module: string, plugin: string, providerWake: boolean }): NitroConfig {
  const nitro = cloneNitroConfig(value)
  nitro.plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(plugin => !isGeneratedNitroRegistration(plugin, generatedNitroSchedulePlugin))
    : []
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(options.plugin)
  // SAFETY: The kit preserves the Nitro config object shape while adding only Nitro plugins.
  const configured = kit.config as NitroConfig
  if (!options.providerWake) return configured
  configured.modules = [
    ...(Array.isArray(configured.modules)
      ? configured.modules.filter(module => !isGeneratedNitroRegistration(module, generatedNitroScheduleModule))
      : []),
    options.module,
  ]
  configured.cloudflare ||= {}
  configured.cloudflare.wrangler ||= {}
  const wrangler = configured.cloudflare.wrangler
  const existingTriggers = isRecord(wrangler.triggers) ? wrangler.triggers : {}
  const existingCrons = Array.isArray(existingTriggers.crons)
    ? existingTriggers.crons.filter((cron): cron is string => typeof cron === "string")
    : []
  wrangler.triggers = {
    ...existingTriggers,
    crons: [...new Set([...existingCrons, ...options.crons])],
  }
  return configured
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
  cronOverrides: ScheduleCronOverrides
  timeZoneCrons: ScheduleTimeZoneCrons
  /** The module that exports the app's `databases`. The Process Runtime claims occurrences in its Default Database. */
  leaseDatabaseImport?: string
  pluginFile: string
  /** Set when a Definition has no `cron`: the registry of those Definitions, for `startSchedule()` and the tick. */
  startedRegistryFile?: string
  processRuntime?: ScheduleProcessRuntimeOptions
  /** The static cron and time zone of each Process Runtime Schedule, so the runtime loads its module when it is due. */
  processTimings?: Record<string, { cron: string, timeZone?: string }>
  providerDefinitions: DiscoveredScheduleDefinition[]
  providerRegistryFile: string
  staticRegistryFile: string
  runtimeImport?: string
}

// Generated code imports these Schedule runtime modules by path, so they need no package export.
const scheduleRuntimeModule = ownModule(import.meta.url, "runtime")
const scheduleKVRuntimeModule = ownModule(import.meta.url, "runtime/kv")
const scheduleProcessRuntimeModule = ownModule(import.meta.url, "runtime/process")
const scheduleStaticRuntimeModule = ownModule(import.meta.url, "runtime/static")

function renderNitroSchedulePlugin(options: RenderNitroSchedulePluginOptions): string {
  const providerWake = options.providerDefinitions.length > 0
  const processRuntime = options.processRuntime
  const processRuntimeOptions = processRuntime
      ? {
        ...(processRuntime.catchUpMs !== undefined ? { catchUpMs: processRuntime.catchUpMs } : {}),
        ...(processRuntime.concurrency !== undefined ? { concurrency: processRuntime.concurrency } : {}),
        ...(processRuntime.intervalMs !== undefined ? { intervalMs: processRuntime.intervalMs } : {}),
        ...(processRuntime.leaseTtlMs !== undefined ? { leaseTtlMs: processRuntime.leaseTtlMs } : {}),
        ...(processRuntime.prefix !== undefined ? { prefix: processRuntime.prefix } : {}),
        ...(options.processTimings && Object.keys(options.processTimings).length ? { timings: options.processTimings } : {}),
      }
    : undefined
  const leaseDatabaseImport = processRuntime ? options.leaseDatabaseImport : undefined
  const scheduleStoreOptions = processRuntime?.prefix !== undefined ? { prefix: processRuntime.prefix } : {}
  return [
    "import { definePlugin } from 'nitro'",
    ...(providerWake
      ? [
          `import scheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.providerRegistryFile))}`,
          `import { executeCloudflareStaticSchedules } from ${JSON.stringify(options.runtimeImport ?? scheduleStaticRuntimeModule)}`,
        ]
      : []),
    ...(processRuntime
      ? [
          `import { normalizeScheduleRuntimeError } from ${JSON.stringify(options.runtimeImport ?? scheduleStaticRuntimeModule)}`,
          `import { createKVScheduleRunStore } from ${JSON.stringify(scheduleRuntimeModule)}`,
          `import { scheduleKVStorage } from ${JSON.stringify(scheduleKVRuntimeModule)}`,
          `import { installProcessScheduleRuntime, onShutdown${leaseDatabaseImport ? ", scheduleLeaseStoreFromDatabase" : ""} } from ${JSON.stringify(scheduleProcessRuntimeModule)}`,
          ...(leaseDatabaseImport ? [`import { databases } from ${JSON.stringify(leaseDatabaseImport)}`] : []),
          `import staticScheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.staticRegistryFile))}`,
        ]
      : []),
    ...(options.startedRegistryFile
      ? [
          `import { createKVStartedScheduleStore, installStartedSchedules } from ${JSON.stringify(scheduleRuntimeModule)}`,
          ...(processRuntime ? [] : [`import { scheduleKVStorage } from ${JSON.stringify(scheduleKVRuntimeModule)}`]),
          `import startedScheduleRegistry from ${JSON.stringify(moduleImportSpecifier(options.pluginFile, options.startedRegistryFile))}`,
        ]
      : []),
    "",
    ...(processRuntime
      ? [
          `const processRuntimeOptions = ${JSON.stringify(processRuntimeOptions, null, 2)}`,
          `const scheduleStoreOptions = { ...${JSON.stringify(scheduleStoreOptions, null, 2)}, kvStore: scheduleKVStorage }`,
          "",
        ]
      : []),
    "export default definePlugin((nitroApp) => {",
    ...(options.startedRegistryFile
      ? [
          // The Process Runtime keeps runs in KV, so its first tick can run the minutes that a restart missed. Other
          // hosts keep runs in memory, so a tick checks only its own minute.
          "  installStartedSchedules({",
          `    catchUpMs: ${processRuntime ? processRuntime.catchUpMs ?? defaultCatchUpMs : 0},`,
          "    registry: startedScheduleRegistry,",
          `    store: createKVStartedScheduleStore({ ...${JSON.stringify(scheduleStoreOptions)}, kvStore: scheduleKVStorage }),`,
          "  })",
        ]
      : []),
    ...(providerWake
      ? [
          "  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {",
          `    await executeCloudflareStaticSchedules(event, { ${[
            Object.keys(options.cronOverrides).length ? `cronOverrides: ${JSON.stringify(options.cronOverrides)}, ` : "",
            "registry: scheduleRegistry",
            Object.keys(options.timeZoneCrons).length ? `, timeZoneCrons: ${JSON.stringify(options.timeZoneCrons)}` : "",
          ].join("")} })`,
          "  })",
        ]
      : []),
    ...(processRuntime
      ? [
          "  function captureRuntimeError(error: unknown) {",
          "    let runtimeError: Error",
          "    try {",
          "      runtimeError = normalizeScheduleRuntimeError(error)",
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
          ...(leaseDatabaseImport
            ? [
                // Every server of the app claims each occurrence in the Default Database, so one server runs it.
                "  const leases = scheduleLeaseStoreFromDatabase(databases.default.db)",
                "  if (!leases) console.warn('[vitehub:schedule] The Default Database has no postgres.js or libSQL client, so each server process runs every Schedule. Use a Postgres or remote libSQL Default Database to run more than one server.')",
              ]
            : []),
          "  const runtimeInstallation = installProcessScheduleRuntime({",
          "    ...processRuntimeOptions,",
          ...(leaseDatabaseImport ? ["    ...(leases ? { leases } : {}),"] : []),
          "    onError: captureRuntimeError,",
          "    registry: staticScheduleRegistry,",
          "    scheduleRunStore: createKVScheduleRunStore(scheduleStoreOptions),",
          "  }).then(",
          "    controller => ({ controller }),",
          "    error => {",
          "      captureRuntimeError(error)",
          "      return { error }",
          "    },",
          "  )",
          "  // ViteHub runs this drain on a stop signal, before the server closes HTTP, or when Nitro closes.",
          "  onShutdown(nitroApp, 'schedule', () => runtimeInstallation.then(async (result) => {",
          "    if ('controller' in result) await result.controller.close()",
          "  }).catch(captureRuntimeError))",
          "  nitroApp.hooks.hook('request', async () => {",
          "    const result = await runtimeInstallation",
          "    if ('error' in result) throw result.error",
          "  })",
        ]
      : []),
    "})",
    "",
    `export const vitehubScheduleDefinitions = ${JSON.stringify(options.providerDefinitions.map(definition => definition.name))}`,
    "",
  ].join("\n")
}

interface NitroNetlifySchedule {
  cron: string
  /** `true` when `cron` is the UTC cron of a Schedule with a `timeZone`. */
  inTimeZone?: boolean
  name: string
}

interface RenderNitroScheduleModuleOptions {
  crons: string[]
  netlify: {
    entryFile: string
    registryFile: string
    runtimeImport: string
    schedules: NitroNetlifySchedule[]
  }
}

/**
 * On Cloudflare, adds the cron triggers. On Netlify, Nitro has no cron, so each Schedule gets a scheduled function
 * that runs it in Nitro's own server bundle: the plugins, aliases, and bindings of the app are the same as for requests.
 */
function renderNitroScheduleModule(options: RenderNitroScheduleModuleOptions): string {
  const { netlify } = options
  let netlifyFunctionNames = new Map<string, string>()
  let netlifyNameError: { code: string, message: string, name: string } | undefined
  try {
    netlifyFunctionNames = netlifyScheduleFunctionNames(netlify.schedules)
  }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "SCHEDULE_R0006") throw error
    // The names are known now, but only Nitro's resolved Netlify preset may reject them.
    netlifyNameError = { ...error, code: error.code, message: error.message, name: error.name }
  }
  const netlifySchedules = netlify.schedules.map(schedule => ({ ...schedule, functionName: netlifyFunctionNames.get(schedule.name) }))
  const crons = Object.fromEntries(netlify.schedules.map(schedule => [schedule.name, schedule.cron]))
  const timeZoneNames = netlify.schedules.filter(schedule => schedule.inTimeZone).map(schedule => schedule.name)
  const netlifyEntryRuntime = [
    `import scheduleRegistry from ${JSON.stringify(netlify.registryFile)}`,
    `import { executeStaticSchedule, isTimeZoneWakeDue, missingScheduleDefinitionError, scheduledWakeTime, unwrapScheduleDefinition } from ${JSON.stringify(netlify.runtimeImport)}`,
    "",
    `const crons = ${JSON.stringify(crons)}`,
    `const timeZoneNames = new Set(${JSON.stringify(timeZoneNames)})`,
    "",
    "export async function runViteHubNetlifySchedule(name) {",
    "  const loader = scheduleRegistry[name]",
    "  const definition = loader ? unwrapScheduleDefinition(await loader()) : undefined",
    "  if (!definition) throw missingScheduleDefinitionError(name)",
    "  const scheduledAt = scheduledWakeTime(crons[name])",
    "  if (timeZoneNames.has(name) && !isTimeZoneWakeDue(definition, name, scheduledAt)) return",
    "  await executeStaticSchedule({ cron: crons[name], definition, name, scheduledAt })",
    "}",
    "",
  ].join("\n")
  return [
    "import { cp, rm, writeFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    "",
    `const crons = ${JSON.stringify(options.crons)}`,
    `const netlifySchedules = ${JSON.stringify(netlifySchedules)}`,
    `const netlifyNameError = ${JSON.stringify(netlifyNameError ?? null)}`,
    `const netlifyEntryFile = ${JSON.stringify(netlify.entryFile)}`,
    `const netlifyEntryRuntime = ${JSON.stringify(netlifyEntryRuntime)}`,
    "",
    "function dedupeCloudflareCrons(nitro) {",
    "  const wrangler = nitro.options.cloudflare?.wrangler",
    "  if (!wrangler?.triggers || !Array.isArray(wrangler.triggers.crons)) return",
    "  wrangler.triggers.crons = [...new Set(wrangler.triggers.crons.filter((cron) => typeof cron === 'string'))]",
    "}",
    "",
    "async function writeNetlifyScheduleFunctions(nitro) {",
    "  // Netlify Build reads generated sources from functions-internal or v1/functions, then bundles into functions.",
    "  // Keeping schedules in Nitro's cleaned output also removes functions for deleted or renamed Schedules.",
    "  const { dir: functionsDir, serverDir } = nitro.options.output",
    "  for (const { cron, functionName, name } of netlifySchedules) {",
    "    const functionDir = join(functionsDir, functionName)",
    "    await rm(functionDir, { force: true, recursive: true })",
    "    // Netlify deploys each function directory alone, so each one gets its own copy of the server bundle.",
    "    await cp(serverDir, functionDir, { filter: source => source !== join(serverDir, 'server.mjs'), recursive: true })",
    "    await writeFile(join(functionDir, `${functionName}.mjs`), [",
    "      \"import { runViteHubNetlifySchedule } from './main.mjs'\",",
    "      '',",
    "      'export default async function vitehubNetlifySchedule() {',",
    "      `  await runViteHubNetlifySchedule(${JSON.stringify(name)})`,",
    "      '  return new Response(null, { status: 204 })',",
    "      '}',",
    "      '',",
    "      `export const config = ${JSON.stringify({ includedFiles: ['**'], nodeBundler: 'none', schedule: cron })}`,",
    "      '',",
    "    ].join('\\n'))",
    "  }",
    "}",
    "",
    "export default async function vitehubScheduleModule(nitro) {",
    "  nitro.options.cloudflare ??= {}",
    "  nitro.options.cloudflare.wrangler ??= {}",
    "  nitro.options.cloudflare.wrangler.triggers ??= {}",
    "  const existingCrons = Array.isArray(nitro.options.cloudflare.wrangler.triggers.crons) ? nitro.options.cloudflare.wrangler.triggers.crons : []",
    "  nitro.options.cloudflare.wrangler.triggers.crons = [...new Set([...existingCrons, ...crons])]",
    "  nitro.hooks.hook('build:before', dedupeCloudflareCrons)",
    "  if (nitro.options.preset !== 'netlify') return",
    "  if (netlifyNameError) throw Object.assign(new Error(netlifyNameError.message), netlifyNameError)",
    "  if (!netlifySchedules.length) return",
    "  // The server bundle keeps Nitro's entry and also exports the Schedule runner for the scheduled functions.",
    "  await writeFile(netlifyEntryFile, `export { default } from ${JSON.stringify(nitro.options.entry)}\\n${netlifyEntryRuntime}`)",
    "  nitro.options.entry = netlifyEntryFile",
    "  // Register after all modules have installed their compiled writers, including Database migrations.",
    "  nitro.hooks.hookOnce('build:before', () => {",
    "    nitro.hooks.hook('compiled', writeNetlifyScheduleFunctions)",
    "  })",
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
  cronOverrides: ScheduleCronOverrides
  leaseDatabaseImport?: string
  startableDefinitions: DiscoveredScheduleDefinition[]
  timeZoneCrons: ScheduleTimeZoneCrons
  crons: string[]
  importBase?: string
  netlifySchedules: NitroNetlifySchedule[]
  processRuntime?: ScheduleProcessRuntimeOptions
  processTimings?: Record<string, { cron: string, timeZone?: string }>
  providerDefinitions: DiscoveredScheduleDefinition[]
  staticDefinitions: DiscoveredScheduleDefinition[]
  runtimeImport?: string
}

async function writeNitroSchedulePlugin(root: string, options: WriteNitroSchedulePluginOptions): Promise<string> {
  const pluginFile = resolve(root, generatedNitroSchedulePlugin)
  const moduleFile = resolve(root, generatedNitroScheduleModule)
  const providerRegistryFile = resolve(root, generatedNitroProviderRegistry)
  const staticRegistryFile = resolve(root, generatedNitroStaticRegistry)
  const startedRegistryFile = options.startableDefinitions.length ? resolve(root, generatedNitroStartedRegistry) : undefined
  // A CLI command that loads the project renders the same files while the dev server watches them. A rewrite of the
  // same bytes would reload the dev server's Nitro worker, which can read the file while it is empty.
  const writes: Array<Promise<void>> = [
    writeFileIfChanged(pluginFile, renderNitroSchedulePlugin({
      cronOverrides: options.cronOverrides,
      timeZoneCrons: options.timeZoneCrons,
      leaseDatabaseImport: options.leaseDatabaseImport,
      pluginFile,
      startedRegistryFile,
      processRuntime: options.processRuntime,
      ...(options.processTimings ? { processTimings: options.processTimings } : {}),
      providerDefinitions: options.providerDefinitions,
      providerRegistryFile,
      staticRegistryFile,
      runtimeImport: options.runtimeImport,
    })),
  ]
  if (startedRegistryFile) {
    writes.push(writeFileIfChanged(startedRegistryFile, createRuntimeRegistryContents(startedRegistryFile, options.startableDefinitions)))
    writes.push(writeFileIfChanged(startedRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase)))
  }
  if (options.processRuntime) {
    writes.push(writeFileIfChanged(staticRegistryFile, createRuntimeRegistryContents(staticRegistryFile, options.staticDefinitions)))
    writes.push(writeFileIfChanged(staticRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase)))
  }
  if (options.providerDefinitions.length > 0) {
    writes.push(writeFileIfChanged(providerRegistryFile, createRuntimeRegistryContents(providerRegistryFile, options.providerDefinitions)))
    writes.push(writeFileIfChanged(providerRegistryFile.replace(/\.js$/, ".d.ts"), renderScheduleRegistryTypes(options.importBase)))
    writes.push(writeFileIfChanged(moduleFile, renderNitroScheduleModule({
      crons: options.crons,
      netlify: {
        entryFile: resolve(root, generatedNitroNetlifyEntry),
        registryFile: providerRegistryFile,
        runtimeImport: options.runtimeImport ?? scheduleStaticRuntimeModule,
        schedules: options.netlifySchedules,
      },
    })))
  }
  await Promise.all(writes)
  return generatedNitroSchedulePlugin
}

function hasServerScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): boolean {
  return definitions.some(isServerScheduleDefinition)
}

function hasViteSuffixScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): boolean {
  return definitions.some(definition => definition.source === "vite-suffix")
}

function selectNitroScheduleDefinitions(definitions: DiscoveredScheduleDefinition[], options: ScheduleOptions): DiscoveredScheduleDefinition[] {
  if (options.providerOutput === false || options.providerOutput === "standalone") return []
  if (options.providerOutput === "nitro") return definitions
  return definitions.filter(isServerScheduleDefinition)
}

function selectStandaloneProviderSource(definitions: DiscoveredScheduleDefinition[], options: ScheduleOptions): DiscoveredScheduleDefinition["source"] | undefined {
  if (options.providerOutput === "auto" || options.providerOutput === undefined) {
    return hasServerScheduleDefinitions(definitions) ? "vite-suffix" : undefined
  }
}

function shouldInstallNitroSchedulePlugin(definitions: DiscoveredScheduleDefinition[], options: ScheduleOptions, startable: number): boolean {
  return selectNitroScheduleDefinitions(definitions, options).length > 0 || options.runtime !== undefined || startable > 0
}

function shouldEmitStandaloneProviderOutput(definitions: DiscoveredScheduleDefinition[], options: ScheduleOptions): boolean {
  if (options.providerOutput === false || options.providerOutput === "nitro") return false
  if (options.providerOutput === "standalone") return definitions.length > 0
  if (hasServerScheduleDefinitions(definitions)) return hasViteSuffixScheduleDefinitions(definitions)
  return definitions.length > 0
}

export async function createScheduleNitroConfig(options: ScheduleNitroConfigOptions = {}): Promise<NitroConfig | null> {
  const processRuntime = resolveProcessRuntimeOptions(options.runtime)
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
  const startableDefinitions = discoverStartableScheduleDefinitions({
    contributions,
    rootDir: roots.viteRoot,
    serverDirs: options.serverDirs,
    serverRootDir: roots.projectRoot,
  })
  const cronOverrides = resolveCronOverrides(options.cron, (options as InternalScheduleNitroConfigOptions).preliminary ? undefined : definitions, options)
  const installNitroPlugin = shouldInstallNitroSchedulePlugin(definitions, options, startableDefinitions.length)
  const nitroPreset = isRecord(options.nitro) && typeof options.nitro.preset === "string"
    ? options.nitro.preset
    : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING || ""
  const standaloneProviderSource = selectStandaloneProviderSource(definitions, options)
  const vercelDefinitions = options.command === "build"
    && nitroPreset.startsWith("vercel")
    && (options.runtime === undefined || options.providerOutput === "standalone")
    && shouldEmitStandaloneProviderOutput(definitions, options)
    ? definitions.filter(definition => standaloneProviderSource === undefined || definition.source === standaloneProviderSource)
    : []
  if (!installNitroPlugin && !vercelDefinitions.length) return null

  let nitro = options.nitro
  if (vercelDefinitions.length) {
    nitro = mergeNitroVercelCrons(nitro, vercelDefinitions, await readDefinitionCrons(vercelDefinitions, cronOverrides))
  }
  if (!installNitroPlugin) return nitro as NitroConfig

  const internal = options as InternalScheduleNitroConfigOptions
  if (processRuntime && options.command === "build" && !internal.preliminary && !internal.leaseDatabaseImport) {
    console.warn("[vitehub:schedule] The Process Runtime claims each Schedule occurrence in memory, because the app has no Database. Run one server only, or add a Postgres Database so that more than one server runs each occurrence once.")
  }
  const nitroDefinitions = processRuntime && options.providerOutput !== "nitro" ? [] : selectNitroScheduleDefinitions(definitions, options)
  const nitroCrons = options.command === "build" ? await readDefinitionCrons(nitroDefinitions, cronOverrides) : new Map<string, string>()
  const timeZoneCrons = options.command === "build" ? readTimeZoneCrons(nitroDefinitions, cronOverrides) : {}
  const crons = [...new Set(nitroCrons.values())]
  const netlifySchedules = [...nitroCrons].map(([name, cron]) => ({ cron, ...(Object.hasOwn(timeZoneCrons, name) ? { inTimeZone: true } : {}), name }))
  const nitroDefinitionNames = new Set(nitroDefinitions.map(definition => definition.name))
  const staticDefinitions = definitions.filter(definition =>
    !nitroDefinitionNames.has(definition.name)
    && !(processRuntime && options.providerOutput === "standalone")
  )
  // A build reads each static cron from source, so the server starts without importing the Schedule modules and what
  // they import. `vite dev` loads them at startup, so an edited cron applies without a new plugin file.
  const processTimings = processRuntime && options.command === "build"
    ? Object.fromEntries(staticDefinitions.flatMap((definition) => {
        const timing = readStaticScheduleTiming(definition.handler)
        return timing ? [[definition.name, timing]] : []
      }))
    : undefined
  const plugin = await writeNitroSchedulePlugin(roots.projectRoot, {
    cronOverrides: Object.fromEntries(Object.entries(cronOverrides ?? {}).filter(([name]) => nitroDefinitionNames.has(name))),
    crons,
    importBase: (options as InternalScheduleVitePluginOptions).importBase,
    leaseDatabaseImport: (options as InternalScheduleNitroConfigOptions).leaseDatabaseImport,
    netlifySchedules,
    timeZoneCrons,
    processRuntime,
    ...(processTimings ? { processTimings } : {}),
    providerDefinitions: nitroDefinitions,
    startableDefinitions,
    staticDefinitions,
    runtimeImport: (options as InternalScheduleVitePluginOptions).runtimeImport,
  })
  return mergeNitroScheduleConfig(nitro, {
    crons,
    module: options.nitroOwnsPaths
      ? resolve(roots.projectRoot, generatedNitroScheduleModule)
      : generatedNitroScheduleModule,
    plugin: options.nitroOwnsPaths
      ? resolve(roots.projectRoot, plugin)
      : plugin,
    providerWake: nitroDefinitions.length > 0,
  })
}

export function hubSchedule(options: ScheduleOptions = {}): ScheduleVitePlugin {
  const internalOptions = options as InternalScheduleVitePluginOptions
  let resolved: ResolvedConfig | undefined
  let emitStandaloneProviderOutput = true
  let projectRoot: string | undefined
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  const providerOutputEnvironment = createProviderOutputEnvironmentOwner(SCHEDULE_VITE_PLUGIN_NAME)
  let nitroPreset: string | undefined
  let standaloneProviderSource: DiscoveredScheduleDefinition["source"] | undefined
  let serverDirs: string[] | undefined
  let viteRoot: string | undefined
  let contributions: CollectedScheduleContribution[] = []
  const leaseDatabaseImport = (plugins: readonly unknown[] | undefined) => hasVitePlugin(plugins, databaseVitePluginName)
    ? { leaseDatabaseImport: internalOptions.databaseImport ?? "@vite-hub/database/drizzle" }
    : {}

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

  function createRegistryContents() {
    return renderScheduleRegistryModule(discoverRegistrySchedules())
  }

  const plugin: Plugin = {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    enforce: "pre",
    async config(config, env) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const roots = resolveSchedulePluginRoots(config.root || process.cwd(), options)
      contributions = await collectPluginScheduleContributions(config.plugins, roots)
      const definitions = discoverScheduleDefinitions({
        contributions,
        rootDir: roots.viteRoot,
        serverDirs,
        serverRootDir: roots.projectRoot,
      })
      emitStandaloneProviderOutput = (options.runtime === undefined || options.providerOutput === "standalone") && shouldEmitStandaloneProviderOutput(definitions, options)
      standaloneProviderSource = selectStandaloneProviderSource(definitions, options)
      const nitroOptions: InternalScheduleNitroConfigOptions = {
        ...options,
        command: env.command,
        contributions,
        nitroOwnsPaths: hasNitroConfigContext(config),
        nitro: (config as { nitro?: unknown }).nitro,
        ...leaseDatabaseImport(config.plugins),
        preliminary: true,
        root: config.root || process.cwd(),
        serverDirs,
      }
      const nitro = await createScheduleNitroConfig(nitroOptions)
      if (!nitro) return null
      ;(config as ViteConfigWithNitro).nitro = nitro
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      const roots = resolveSchedulePluginRoots(config.root, options)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
      // The resolved list includes plugins that other plugins add after the `config` hook.
      contributions = await collectPluginScheduleContributions(config.plugins, roots)
      const definitions = discoverRegistrySchedules()
      emitStandaloneProviderOutput = (options.runtime === undefined || options.providerOutput === "standalone") && shouldEmitStandaloneProviderOutput(definitions, options)
      standaloneProviderSource = selectStandaloneProviderSource(definitions, options)
      if (config.command) {
        const nitro = await createScheduleNitroConfig({
          ...options,
          command: config.command,
          contributions,
          nitro: (config as ResolvedConfig & { nitro?: unknown }).nitro,
          nitroOwnsPaths: hasNitroConfigContext(config),
          ...leaseDatabaseImport(config.plugins),
          root: config.root,
          serverDirs,
        } as InternalScheduleNitroConfigOptions)
        if (nitro) {
          // SAFETY: Nitro integrations attach their generated config to the resolved Vite config at runtime.
          const configWithNitro = config as Omit<ResolvedConfig, "nitro"> & { nitro?: NitroConfig }
          configWithNitro.nitro = nitro
        }
      }
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
    resolveId: {
      filter: { id: /^#vitehub\/schedule\/registry$/ },
      handler(id) {
        if (id === SCHEDULE_REGISTRY_ID) {
          return RESOLVED_SCHEDULE_REGISTRY_ID
        }
      },
    },
    load: {
      filter: { id: /^\0#vitehub\/schedule\/registry$/ },
      handler(id) {
        if (id === RESOLVED_SCHEDULE_REGISTRY_ID) {
          return createRegistryContents()
        }
      },
    },
    buildApp: providerOutputEnvironment.buildApp,
    buildStart() {
      if (providerOutputEnvironment.defers(this)) return
      providerOutputGenerations.capture(this, providerOutput)
    },
    async buildEnd(error) {
      if (providerOutputEnvironment.defers(this)) return
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command)) {
        return
      }
      const config = resolved
      const rootDir = projectRoot ?? config.root
      let artifactDir: string | undefined
      try {
        const discovered = discoverRegistrySchedules()
        const definitions = emitStandaloneProviderOutput ? discovered : []
        const cron = resolveCronOverrides(options.cron, discovered, options)
        const crons = await readDefinitionCrons(definitions, cron)
        const prepareWorkflow = definitions.length
          ? ((config.plugins ?? []) as WorkflowVitePlugin[])
            .find(candidate => candidate.vitehub?.workflow?.prepareScheduleRuntime)
            ?.vitehub?.workflow?.prepareScheduleRuntime
          : undefined
        artifactDir = resolve(rootDir, ".vitehub/schedule-generations", randomUUID())
        const contributionArtifactDir = artifactDir
        const workflow = await prepareWorkflow?.(resolve(contributionArtifactDir, "workflow"))
        // Only provider functions bundle with these aliases, and resolving every owner package export costs time.
        const bundles = definitions.length > 0 || Boolean(workflow)
        const contributedAliases = bundles
          ? await collectViteHubProviderImportAliases((config.plugins ?? []) as Array<Plugin & ViteHubProviderImportContributor>)
          : {}
        const aliases = {
          ...resolveStringAliases(config),
          ...contributedAliases,
          ...internalOptions.providerImportAliases,
          ...workflow?.bundleAlias,
        }
        const retainedSources = bundles
          ? await retainProviderOutputSources({
              artifactDir: resolve(contributionArtifactDir, "sources"),
              paths: [...definitions.map(definition => definition.handler), ...providerOutputAliasSources(aliases, [rootDir])],
              roots: [rootDir],
            })
          : { resolve: (path: string) => path }
        if (bundles) {
          // SAFETY: Configured plugins may expose the optional ViteHub provider contribution contract.
          await prepareViteHubProviderSources((config.plugins ?? []) as Array<Plugin & ViteHubProviderImportContributor>, retainedSources)
        }
        const retainedDefinitions = definitions.map(definition => ({
          ...definition,
          handler: retainedSources.resolve(definition.handler),
        }))
        const retainedAliases = retainProviderOutputAliases(aliases, retainedSources)
        const bundleExternal = workflow
          ? ["@vitejs/devtools-core", "@vitejs/devtools-kit", "@vitejs/devtools-rolldown"]
          : undefined
        contributeProviderDeploymentOutput(providerOutput, {
          discard: async () => await removeProviderOutputArtifactDir(contributionArtifactDir),
          owner: "schedule",
          rootDir,
          write: async ({ signal }) => {
            signal.throwIfAborted()
            const artifacts = await generateProviderOutputsWithinLock({
              bundleAlias: retainedAliases,
              bundleExternal,
              clientOutDir: resolve(config.root, config.build.outDir),
              definitions: retainedDefinitions,
              cron,
              crons,
              rootDir,
              retainedSourcesDir: resolve(contributionArtifactDir, "sources"),
              // Nitro resolves the preset of the server it builds. Without Nitro, the Vite config or the environment names the host.
              host: resolveHost({ nitro: nitroPreset ? { preset: nitroPreset } : (config as ResolvedConfig & { nitro?: unknown }).nitro }),
              runtimeImport: internalOptions.runtimeImport,
              signal,
              source: standaloneProviderSource,
              sourceRootDir: retainedSources.resolve(rootDir),
              workflow,
            })
            if (artifacts.definitions.length === 0) {
              await rm(resolve(rootDir, ".vitehub", "schedule", "sources"), { force: true, recursive: true })
            }
          },
        }, providerOutputGenerations.get(this))
      }
      catch (error) {
        if (artifactDir) await removeProviderOutputArtifactDir(artifactDir)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      if (providerOutputEnvironment.defers(this)) return
      await providerOutputGenerations.reset(this, providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (providerOutputEnvironment.defers(this)) return
        if (!resolved || shouldSkipViteProviderBuild(resolved.command)) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }

  // SAFETY: The implementation above supplies Vite's plugin hooks plus ViteHub's intentionally loose public hook index.
  const inspectable = plugin as ScheduleVitePlugin
  // Nitro installs this module, which tells the plugin whether Nitro builds a server environment and for which preset.
  inspectable.nitro = {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    setup(nitro: { options: { preset?: string, static?: boolean } }) {
      // Nitro's prerenderer installs the modules again, with its own `nitro-prerender` preset, before the server build.
      if (nitro.options.preset !== "nitro-prerender") nitroPreset = nitro.options.preset
      providerOutputEnvironment.nitro.setup(nitro)
    },
  }
  inspectable.vitehub = {
    // Only the process runtime runs schedules in the server. Other hosts trigger them from their own cron.
    durability: () => options.runtime?.driver === "process"
      ? [{ export: "scheduleDurability", input: { driver: "process" }, module: durabilityModuleFile(import.meta.url), primitive: "schedule" }]
      : [],
    // The Console, `vitehub schedule`, and agents run these. The app imports them through `vite-hub`.
    operations: [{ export: "scheduleOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).scheduleOperations, module: ownModule(import.meta.url, "operations") }],
    inspect: () => ({
      definitions: [{
        kind: "schedule",
        label: "Schedules",
        list: () => {
          const roots = resolveSchedulePluginRoots(viteRoot ?? process.cwd(), options)
          return inspectScheduleDefinitions({ cron: options.cron, plugins: resolved?.plugins, projectRoot: roots.projectRoot, rootDir: roots.viteRoot, serverDirs, serverRootDir: roots.projectRoot })
        },
      }],
    }),
  } satisfies ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & { operations: readonly OperationContributionEntry[] }
  return inspectable
}
