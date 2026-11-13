import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { parseCronExpression } from "cron-schedule"
import { cloudflareRuntimeExternal, defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot, createDefaultVercelOutputRoot, recoverNetlifyDeploymentOutput, withProviderDeploymentOutputLock } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir, ownModule } from "@vite-hub/internal/build/paths"
import { publishProviderSourcesToDeploymentOutputs, rebasePublishedProviderSourceLinks, removeProviderOutputArtifactDir, rewriteRetainedProviderSourcePaths } from "@vite-hub/internal/build/provider-output-sources"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vite-hub/internal/build/vercel-config"
import { writeRuntimeRegistryFile } from "@vite-hub/internal/definition-catalog"
import { findDefaultExportCall, findProperty, scanModule, staticString } from "@vite-hub/internal/build/scan-module"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { getVercelSchedulePath } from "../integrations/vercel.ts"
import { utcCronForTimeZone } from "./time-zone-cron.ts"

import type { Plugin } from "esbuild"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { DiscoveredScheduleDefinition } from "../types.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"
import { isRecord } from "@vite-hub/internal/object"

export const schedulePackageName = "@vite-hub/schedule"
// Deno cron output keeps npm packages external, so it imports the static runtime from the deployed package.
const scheduleStaticRuntimeImport = "@vite-hub/schedule/runtime/static"
const productName = "schedule"
const cloudflareOutputStateFileName = "cloudflare-output.json"
const cloudflareScheduleWorkerMarker = "vitehub-schedule-provider-output"
const deployedScheduleSourcesPath = ".vitehub/schedule/sources"
const denoCronFileName = "deno-cron.mjs"
const generatedRegistryFileName = "registry.mjs"

type ImportResolver = (specifier: string) => string

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function isVercelCron(value: unknown): value is { path: string, schedule: string } {
  return isRecord(value) && typeof value.path === "string" && typeof value.schedule === "string"
}

export function resolveScheduleDefinitionEntry(resolveImport: ImportResolver = specifier => import.meta.resolve(specifier)) {
  const packageRoot = dirname(fileURLToPath(resolveImport(`${schedulePackageName}/package.json`)))
  return resolve(packageRoot, "dist/definition.js")
}

// Generated Schedule functions import the static runtime by path. It is not a package export.
const scheduleRuntimeEntry = ownModule(import.meta.url, "runtime/static")
const scheduleDefinitionEntry = resolveScheduleDefinitionEntry()

interface GeneratedScheduleArtifacts {
  cloudflareWorkerFile: string
  denoCronFile: string
  definitions: DiscoveredScheduleDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  bundleDefines?: Record<string, string>
  bundleAlias?: Record<string, string>
  bundleExternal?: string[]
  clientOutDir: string
  /** Cron overrides of this build, so the Cloudflare Worker matches each trigger to its Schedule. */
  cron?: ScheduleCronOverrides
  crons?: Map<string, string>
  definitions?: DiscoveredScheduleDefinition[]
  /** The host this build targets. Schedule writes wake output only for it, and for every host when it is `undefined`. */
  host?: ViteHubHost
  rootDir: string
  runtimeImport?: string
  retainedSourcesDir?: string
  signal?: AbortSignal
  source?: DiscoveredScheduleDefinition["source"]
  sourceRootDir?: string
  workflow?: ScheduleWorkflowRuntime
}

async function publishRetainedProviderSources(artifacts: GeneratedScheduleArtifacts, retainedSourcesDir: string, signal?: AbortSignal): Promise<GeneratedScheduleArtifacts> {
  signal?.throwIfAborted()
  const generatedDir = artifacts.generatedDir
  const publishedSourcesDir = resolve(generatedDir, "sources")
  const nextDir = `${generatedDir}.${randomUUID()}.next`
  const previousDir = `${generatedDir}.${randomUUID()}.previous`
  let movedPrevious = false
  let publicationSettled = false
  try {
    await cp(generatedDir, nextDir, { recursive: true })
    await rm(resolve(nextDir, "sources"), { force: true, recursive: true })
    const nextSourcesDir = resolve(nextDir, "sources")
    await cp(retainedSourcesDir, nextSourcesDir, { recursive: true })
    await rebasePublishedProviderSourceLinks(nextSourcesDir, retainedSourcesDir, publishedSourcesDir)
    const registryFile = resolve(nextDir, generatedRegistryFileName)
    const registryContents = await readFile(registryFile, "utf8")
    await writeFile(registryFile, rewriteRetainedProviderSourcePaths(registryContents, retainedSourcesDir, publishedSourcesDir, {
      published: resolve(generatedDir, generatedRegistryFileName),
      retained: artifacts.registryFile,
    }), "utf8")
    signal?.throwIfAborted()
    await rename(generatedDir, previousDir)
    movedPrevious = true
    await rename(nextDir, generatedDir)
    signal?.throwIfAborted()
    publicationSettled = true
    await removeProviderOutputArtifactDir(previousDir).catch(() => undefined)
  }
  catch (error) {
    if (publicationSettled) throw error
    await rm(nextDir, { force: true, recursive: true })
    if (movedPrevious) {
      try {
        await rm(generatedDir, { force: true, recursive: true })
        await rename(previousDir, generatedDir)
      }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], "Generated Schedule artifact rollback failed")
      }
    }
    throw error
  }
  return { ...artifacts, registryFile: resolve(generatedDir, generatedRegistryFileName) }
}

export interface ScheduleWorkflowRuntime {
  bundleAlias: Record<string, string>
  bundlePlugins?: Plugin[]
  native: boolean
  registryFile: string
  /** File paths of the Workflow runtime modules that the Schedule function imports. */
  runtimeModules: { state: string, vercelVite: string }
}

async function removeEmptyDirectories(directory: string, rootDir: string): Promise<void> {
  const root = resolve(rootDir)
  let current = resolve(directory)
  const pathFromRoot = relative(root, current)
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return

  while (current !== root) {
    try {
      await rmdir(current)
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        current = dirname(current)
        continue
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") return
      throw error
    }
    current = dirname(current)
  }
}

export interface NetlifyScheduleFunctionOutput {
  cron: string
  file: string
  name: string
  source: string
}

const cronFieldPattern = /^[*,/\-0-9]+$/

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.trim().split(/\s+/)
  const hasVercelDayConflict = fields[2] !== "*" && fields[4] !== "*"
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field)) || hasVercelDayConflict) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0003({ message: `Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare, Vercel, and Netlify.` })
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const definition = findDefaultExportCall(scanModule(readFileSync(file, "utf8"), file), ["defineSchedule"])
  const cron = definition?.options && staticString(findProperty(definition.options, "cron")?.value)
  if (!cron) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0004({ message: `Schedule "${scheduleName}" must declare a static cron string for provider wake output.` })
  }
  return cron
}

/**
 * Reads the `timeZone` option of a `defineSchedule()` call. Returns `undefined`
 * when the call does not declare it, the string when it is static, and `null`
 * when it is present but dynamic.
 */
export function readStaticScheduleTimeZone(file: string): string | null | undefined {
  const definition = findDefaultExportCall(scanModule(readFileSync(file, "utf8"), file), ["defineSchedule"])
  const property = definition?.options && findProperty(definition.options, "timeZone")
  if (!property) return undefined
  return property.value ? staticString(property.value) ?? null : null
}

/**
 * Reads the `cron` and `timeZone` of a `defineSchedule()` call. Returns `undefined` when either is not a static string,
 * so the Process Runtime loads that Schedule at startup to read them.
 */
export function readStaticScheduleTiming(file: string): { cron: string, timeZone?: string } | undefined {
  if (!existsSync(file)) return undefined
  const definition = findDefaultExportCall(scanModule(readFileSync(file, "utf8"), file), ["defineSchedule"])
  if (!definition) return undefined
  const cron = staticString(definition.options && findProperty(definition.options, "cron")?.value)
  const timeZone = definition.options && findProperty(definition.options, "timeZone")
  if (!cron || (timeZone && !(timeZone.value && staticString(timeZone.value)))) return undefined
  const zone = timeZone?.value && staticString(timeZone.value)
  return zone ? { cron, timeZone: zone } : { cron }
}

/** UTC cron per Schedule name that the host runs in place of each Schedule's cron in a time zone. */
export type ScheduleTimeZoneCrons = Readonly<Record<string, string>>

/**
 * Returns the UTC cron that the host runs for each Schedule with a `timeZone`. A Schedule with a `cron` override runs
 * on the override in UTC, so it is not in the map. A time zone that is always UTC needs no map entry.
 */
export function readTimeZoneCrons(definitions: DiscoveredScheduleDefinition[], overrides?: ScheduleCronOverrides): ScheduleTimeZoneCrons {
  const crons: Record<string, string> = {}
  for (const definition of definitions) {
    if (overrides && Object.hasOwn(overrides, definition.name)) continue
    const timeZone = readStaticScheduleTimeZone(definition.handler)
    if (timeZone === undefined || timeZone === "UTC") continue
    if (timeZone === null) {
      throw scheduleErrorDiagnostics.SCHEDULE_R0003({ message: `Schedule "${definition.name}" declares timeZone with a value that is not a static string. Host cron output reads timeZone at build time, so write it as a string literal, such as \`timeZone: "Europe/Madrid"\`.` })
    }
    if (!isIanaTimeZone(timeZone)) {
      throw scheduleErrorDiagnostics.SCHEDULE_R0003({ message: `Schedule "${definition.name}" declares timeZone ${JSON.stringify(timeZone)}, which is not an IANA time zone, such as "Europe/Madrid".` })
    }
    const cron = readStaticScheduleCron(definition.handler, definition.name)
    validateProviderCron(cron, definition.name)
    const utcCron = utcCronForTimeZone(cron, timeZone)
    if (utcCron !== undefined) crons[definition.name] = utcCron
  }
  return crons
}


function renderProviderEntry(file: string, registryFile: string, provider: "cloudflare" | "vercel", scheduleName?: string, workflow?: ScheduleWorkflowRuntime, cronOverrides: ScheduleCronOverrides = {}, timeZoneCrons: ScheduleTimeZoneCrons = {}) {
  const runtimeImport = createImportPath(file, scheduleRuntimeEntry)
  const workflowRuntime = provider === "vercel" ? workflow : undefined
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule, ${provider === "vercel" ? "isScheduleCronAuthorized, " : ""}isTimeZoneWakeDue, missingScheduleDefinitionError, normalizeCron, ${provider === "vercel" ? "scheduledWakeTime, " : ""}unwrapScheduleDefinition } from ${JSON.stringify(runtimeImport)}`,
    ...(workflowRuntime
      ? [
          `import workflowRegistry from ${JSON.stringify(createImportPath(file, workflowRuntime.registryFile))}`,
          `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(workflowRuntime.runtimeModules.state)}`,
          `import { runWithVercelWorkflowRuntimeEvent } from ${JSON.stringify(workflowRuntime.runtimeModules.vercelVite)}`,
          ...(workflowRuntime.native
            ? [
                `import { setVercelWorkflowRuntimeModules } from ${JSON.stringify(workflowRuntime.runtimeModules.vercelVite)}`,
                `import * as workflowApi from "workflow/api"`,
                `import * as workflowRuntime from "workflow/runtime"`,
              ]
            : []),
        ]
      : []),
    "",
    workflowRuntime?.native ? "setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)" : "",
    "async function loadScheduleDefinition(name) {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader()",
    "  return unwrapScheduleDefinition(loaded)",
    "}",
    "",
    `const cronOverrides = ${JSON.stringify(cronOverrides)}`,
    "// UTC cron that the host runs for each Schedule with a timeZone. Each wake checks the local time.",
    `const timeZoneCrons = ${JSON.stringify(timeZoneCrons)}`,
    "",
    "function scheduleCron(name, definition) {",
    "  if (Object.hasOwn(cronOverrides, name)) return cronOverrides[name]",
    "  return Object.hasOwn(timeZoneCrons, name) ? timeZoneCrons[name] : definition.cron",
    "}",
    "",
    "function isWakeDue(name, definition, scheduledAt) {",
    "  return Object.hasOwn(cronOverrides, name) || !Object.hasOwn(timeZoneCrons, name) || isTimeZoneWakeDue(definition, name, scheduledAt)",
    "}",
    "",
    "async function runSchedule(name, cron, scheduledAt) {",
    "  const definition = await loadScheduleDefinition(name)",
    "  if (!definition) {",
    "    throw missingScheduleDefinitionError(name)",
    "  }",
    "  if (!isWakeDue(name, definition, scheduledAt)) return",
    "  return await executeStaticSchedule({ cron, definition, name, scheduledAt })",
    "}",
    "",
    provider === "cloudflare"
      ? [
          "export default {",
          "  async fetch() {",
          "    return new Response('ViteHub schedule provider wake endpoint')",
          "  },",
          "  async scheduled(event, env, ctx) {",
          "    if (typeof event.cron !== 'string' || !event.cron.trim()) return",
          "    const tasks = Object.entries(scheduleRegistry).map(async ([name]) => {",
          "      const definition = await loadScheduleDefinition(name)",
          "      if (!definition || normalizeCron(scheduleCron(name, definition)) !== normalizeCron(event.cron)) return",
          "      const scheduledAt = new Date(event.scheduledTime)",
          "      if (!isWakeDue(name, definition, scheduledAt)) return",
          "      await executeStaticSchedule({ cron: event.cron, definition, name, scheduledAt, waitUntil: (promise) => ctx.waitUntil(promise) })",
          "    })",
          "    await Promise.all(tasks)",
          "  },",
          "}",
        ].join("\n")
      : [
          "export default async function scheduleHandler(req, res) {",
          "  const cronSecret = process.env.CRON_SECRET",
          "  const authorization = req.headers?.authorization || req.headers?.Authorization",
          "  if (cronSecret && !isScheduleCronAuthorized(authorization, cronSecret)) {",
          "    res.statusCode = 401",
          "    res.end('Unauthorized.')",
          "    return",
          "  }",
          "  const url = new URL(req.url || '/', 'https://vitehub.local')",
          "  const prefix = '/api/vitehub/schedules/vercel/'",
          scheduleName === undefined
            ? "  const name = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '')"
            : `  const name = ${JSON.stringify(scheduleName)}`,
          "  const definition = await loadScheduleDefinition(name)",
          "  if (!definition) {",
          "    res.statusCode = 404",
          "    res.end('Missing schedule definition.')",
          "    return",
          "  }",
          ...(workflowRuntime
            ? [
                "  setWorkflowRuntimeConfig({ provider: 'vercel' })",
                "  setWorkflowRuntimeRegistry(workflowRegistry)",
              ]
            : []),
          "  const cron = scheduleCron(name, definition)",
          "  // Vercel sends no scheduled time. This estimate cannot identify a late wake after another cron match.",
          workflowRuntime
            ? "  await runWithVercelWorkflowRuntimeEvent(req, res, () => runSchedule(name, cron, scheduledWakeTime(cron)))"
            : "  await runSchedule(name, cron, scheduledWakeTime(cron))",
          "  res.statusCode = 204",
          "  res.end()",
          "}",
        ].join("\n"),
    "",
  ].join("\n")
}

function renderNetlifyScheduleFunction(file: string, registryFile: string, scheduleName: string, cron: string, includedSourcesDir?: string, inTimeZone = false) {
  const runtimeImport = createImportPath(file, scheduleRuntimeEntry)
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule, isTimeZoneWakeDue, scheduledWakeTime, unwrapScheduleDefinition } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const scheduleName = ${JSON.stringify(scheduleName)}`,
    "",
    "export default async function netlifyScheduleHandler(request) {",
    "  const loaded = await scheduleRegistry[scheduleName]?.()",
    "  const definition = unwrapScheduleDefinition(loaded)",
    "  if (!definition) return new Response('Missing schedule definition.', { status: 404 })",
    "  // Without a scheduled timestamp, attribution and time-zone filtering use the latest host cron match.",
    `  const scheduledAt = scheduledWakeTime(${JSON.stringify(cron)})`,
    ...(inTimeZone ? ["  if (!isTimeZoneWakeDue(definition, scheduleName, scheduledAt)) return new Response(null, { status: 204 })"] : []),
    `  await executeStaticSchedule({ cron: ${JSON.stringify(cron)}, definition, name: scheduleName, scheduledAt })`,
    "  return new Response(null, { status: 204 })",
    "}",
    "",
    "export const config = {",
    ...(includedSourcesDir ? [`  includedFiles: [${JSON.stringify(`${includedSourcesDir}/**`)}],`] : []),
    `  schedule: ${JSON.stringify(cron)},`,
    "}",
    "",
  ].join("\n")
}

/** Names one Netlify function per Schedule, and fails when two Schedules would get the same name. */
export function netlifyScheduleFunctionNames(definitions: readonly Pick<DiscoveredScheduleDefinition, "name">[]): Map<string, string> {
  const names = new Map<string, string>()
  const emitted = new Map<string, string>()
  for (const definition of definitions) {
    const safeName = definition.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
    const functionName = `vitehub-schedule-${safeName || "schedule"}`
    const existingName = emitted.get(functionName)
    if (existingName) {
      throw scheduleErrorDiagnostics.SCHEDULE_R0006({ message: `Schedule "${definition.name}" and "${existingName}" both emit the same Netlify function file: ${functionName}.mjs` })
    }
    emitted.set(functionName, definition.name)
    names.set(definition.name, functionName)
  }
  return names
}

function renderDenoCronEntry(file: string, registryFile: string, crons: Map<string, string>, runtimeImport = scheduleStaticRuntimeImport, timeZoneCrons: ScheduleTimeZoneCrons = {}) {
  const scheduleCrons = [...crons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, cron], index) => {
      const cronId = index.toString(36)
      const safeName = [...name].map(character => /^[a-z0-9 _-]$/i.test(character) ? character : "_").join("")
      const cronNamePrefix = `vitehub-${cronId}-`
      // Deno numbers weekdays 1-7, starting on Sunday. Names preserve the standard cron occurrence set.
      const fields = cron.trim().split(/\s+/)
      if (fields[4] !== "*") {
        const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
        fields[4] = parseCronExpression(cron).weekdays.map(day => weekdays[day]).join(",")
      }
      return { cron, cronName: `${cronNamePrefix}${safeName.slice(0, 64 - cronNamePrefix.length)}`, denoCron: fields.join(" "), inTimeZone: Object.hasOwn(timeZoneCrons, name), name }
    })
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule, isTimeZoneWakeDue, missingScheduleDefinitionError, scheduledWakeTime, unwrapScheduleDefinition } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const scheduleCrons = ${JSON.stringify(scheduleCrons, null, 2)}`,
    "",
    "async function loadScheduleDefinition(name) {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader()",
    "  return unwrapScheduleDefinition(loaded)",
    "}",
    "",
    "for (const { cron, cronName, denoCron, inTimeZone, name } of scheduleCrons) {",
    "  Deno.cron(cronName, denoCron, async () => {",
    "    const definition = await loadScheduleDefinition(name)",
    "    if (!definition) {",
    "      throw missingScheduleDefinitionError(name)",
    "    }",
    "    // Deno provides no occurrence timestamp, including on retries. This is a callback-time estimate.",
    "    const scheduledAt = scheduledWakeTime(cron)",
    "    if (inTimeZone && !isTimeZoneWakeDue(definition, name, scheduledAt)) return",
    "    await executeStaticSchedule({ cron, definition, name, scheduledAt })",
    "  })",
    "}",
    "",
    "export const vitehubScheduleDefinitions = scheduleCrons.map(({ name }) => name)",
    "",
  ].join("\n")
}

function createScheduleDefinitionAliasPlugin(): Plugin {
  return {
    name: "vitehub-schedule-definition-alias",
    setup(build) {
      build.onResolve({ filter: /^@vite-hub\/schedule$/ }, () => ({
        path: scheduleDefinitionEntry,
      }))
    },
  }
}

async function writeProviderEntries(
  rootDir: string,
  source?: DiscoveredScheduleDefinition["source"],
  providedDefinitions?: DiscoveredScheduleDefinition[],
  cronOverrides?: ScheduleCronOverrides,
): Promise<GeneratedScheduleArtifacts> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = (providedDefinitions ?? discoverScheduleDefinitions({ rootDir }))
    .filter(definition => !source || definition.source === source)
  await writeRuntimeRegistryFile(registryFile, definitions)
  const timeZoneCrons = readTimeZoneCrons(definitions, cronOverrides)

  const cloudflareWorkerFile = resolve(generatedDir, "cloudflare-worker.mjs")
  const denoCronFile = resolve(generatedDir, denoCronFileName)
  const vercelServerFile = resolve(generatedDir, "vercel-server.mjs")
  await writeFile(cloudflareWorkerFile, renderProviderEntry(cloudflareWorkerFile, registryFile, "cloudflare", undefined, undefined, cronOverrides, timeZoneCrons), "utf8")
  await writeFile(vercelServerFile, renderProviderEntry(vercelServerFile, registryFile, "vercel", undefined, undefined, cronOverrides, timeZoneCrons), "utf8")

  return { cloudflareWorkerFile, denoCronFile, definitions, generatedDir, registryFile, vercelServerFile }
}

/** Cron per Schedule name for one build's host, in place of the cron that the Schedule Definition declares. */
export type ScheduleCronOverrides = Readonly<Record<string, string>>

/** The UTC cron that the host runs for each Schedule: its `cron` override, its time zone cron, or its own cron. */
export async function readDefinitionCrons(definitions: DiscoveredScheduleDefinition[], overrides?: ScheduleCronOverrides) {
  const crons = await readRuntimeDefinitionCrons(definitions)
  for (const [name, cron] of Object.entries(readTimeZoneCrons(definitions, overrides))) crons.set(name, cron)
  for (const [name, cron] of Object.entries(overrides ?? {})) {
    if (crons.has(name)) crons.set(name, cron)
  }
  for (const [name, cron] of crons) validateProviderCron(cron, name)
  return crons
}

export async function readRuntimeDefinitionCrons(definitions: DiscoveredScheduleDefinition[]) {
  const crons = new Map<string, string>()
  for (const definition of definitions) {
    const cron = readStaticScheduleCron(definition.handler, definition.name)
    crons.set(definition.name, cron)
  }
  return crons
}

export async function writeVercelScheduleFunctions(options: {
  bundleDefines?: Record<string, string>
  bundleAlias?: Record<string, string>
  bundleExternal?: string[]
  definitions: DiscoveredScheduleDefinition[]
  outputRoot: string
  registryFile: string
  rootDir: string
  signal?: AbortSignal
  sourceRootDir?: string
  timeZoneCrons?: ScheduleTimeZoneCrons
  workflow?: ScheduleWorkflowRuntime
}, crons: Map<string, string>) {
  options.signal?.throwIfAborted()
  const definitions = options.definitions
  const outputRoot = options.outputRoot
  const functionRoot = resolve(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")
  const stagedFunctionRoot = `${functionRoot}.pending`
  const backupFunctionRoot = resolve(options.rootDir, ".vitehub", "schedule", "vercel-functions.previous")
  await mkdir(dirname(backupFunctionRoot), { recursive: true })
  await rm(stagedFunctionRoot, { force: true, recursive: true })
  options.signal?.throwIfAborted()

  const emittedFunctionNames = new Map<string, string>()
  for (const definition of definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_").split("/").filter(Boolean).join("/")
    const existingName = emittedFunctionNames.get(safeName)
    if (existingName) {
      throw scheduleErrorDiagnostics.SCHEDULE_R0005({ message: `Schedule "${definition.name}" and "${existingName}" both emit the same Vercel function path: ${safeName}` })
    }
    emittedFunctionNames.set(safeName, definition.name)

    const segments = safeName.split("/")
    const functionDir = resolve(stagedFunctionRoot, ...segments.slice(0, -1), `${segments.at(-1)}.func`)
    const functionFile = resolve(functionDir, "index.mjs")
    const wrapperFile = resolve(functionDir, "index.source.mjs")
    await mkdir(functionDir, { recursive: true })
    options.signal?.throwIfAborted()
    const hostCron = { [definition.name]: crons.get(definition.name)! }
    const inTimeZone = options.timeZoneCrons !== undefined && Object.hasOwn(options.timeZoneCrons, definition.name)
    await writeFile(wrapperFile, renderProviderEntry(wrapperFile, options.registryFile, "vercel", definition.name, options.workflow, inTimeZone ? {} : hostCron, inTimeZone ? hostCron : {}), "utf8")
    await bundleEsmEntry(wrapperFile, functionFile, {
      alias: options.bundleAlias,
      define: options.bundleDefines,
      external: options.bundleExternal,
      format: "esm",
      platform: "node",
      plugins: [createScheduleDefinitionAliasPlugin(), ...(options.workflow?.bundlePlugins ?? [])],
      rootDir: options.sourceRootDir ?? options.rootDir,
      signal: options.signal,
      workingDir: options.sourceRootDir ?? options.rootDir,
    })
    await publishProviderSourcesToDeploymentOutputs({
      destinations: [{
        files: [functionFile],
        runtimeSourcesDir: `./${deployedScheduleSourcesPath}`,
        sourcesDir: resolve(functionDir, deployedScheduleSourcesPath),
      }],
      publishedSourcesDir: resolve(dirname(options.registryFile), "sources"),
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    await rm(wrapperFile, { force: true })
    options.signal?.throwIfAborted()
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  }

  options.signal?.throwIfAborted()
  const configFile = resolve(outputRoot, "config.json")
  const previousConfig = await readFile(configFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  let installedFunctionRoot = false
  let publicationCompleted = false
  rmSync(backupFunctionRoot, { force: true, recursive: true })
  try {
    try {
      renameSync(functionRoot, backupFunctionRoot)
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    }
    try {
      if (definitions.length) {
        mkdirSync(dirname(functionRoot), { recursive: true })
        renameSync(stagedFunctionRoot, functionRoot)
        installedFunctionRoot = true
      }
    }
    catch (error) {
      if (existsSync(backupFunctionRoot)) renameSync(backupFunctionRoot, functionRoot)
      throw error
    }

    let vercelConfig: ReturnType<typeof createVercelConfigJson> & { crons?: Array<{ path: string, schedule: string }> }
    try {
      vercelConfig = JSON.parse(await readFile(configFile, "utf8"))
      options.signal?.throwIfAborted()
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      if (!definitions.length) {
        await removeEmptyDirectories(functionRoot, options.rootDir)
        options.signal?.throwIfAborted()
        publicationCompleted = true
        return
      }
      vercelConfig = createVercelConfigJson()
    }
    const schedulePathPrefix = "/api/vitehub/schedules/vercel/"
    const rawPreviousCrons = vercelConfig.crons
    const previousCrons = Array.isArray(rawPreviousCrons)
      ? rawPreviousCrons.filter(isVercelCron)
      : []
    const hasMalformedCrons = rawPreviousCrons !== undefined
      && (!Array.isArray(rawPreviousCrons) || previousCrons.length !== rawPreviousCrons.length)
    const existingCrons = previousCrons.filter(cron => !cron.path.startsWith(schedulePathPrefix))
    if (!definitions.length && !hasMalformedCrons && existingCrons.length === previousCrons.length) {
      await removeEmptyDirectories(functionRoot, options.rootDir)
      options.signal?.throwIfAborted()
      if (previousCrons.length === 0) {
        delete vercelConfig.crons
        if (isDeepStrictEqual(vercelConfig, createVercelConfigJson())) {
          const outputFiles = await readdir(outputRoot)
          options.signal?.throwIfAborted()
          if (outputFiles.length === 1 && outputFiles[0] === "config.json") {
            await rm(configFile, { force: true })
            options.signal?.throwIfAborted()
            await removeEmptyDirectories(outputRoot, options.rootDir)
          }
        }
      }
      publicationCompleted = true
      return
    }
    const nextCrons = [...existingCrons, ...definitions.map(definition => ({
      path: getVercelSchedulePath(definition.name),
      schedule: crons.get(definition.name)!,
    }))]
    if (nextCrons.length) {
      vercelConfig.crons = nextCrons
    }
    else {
      delete vercelConfig.crons
    }
    if (!definitions.length) {
      await removeEmptyDirectories(functionRoot, options.rootDir)
      options.signal?.throwIfAborted()
      const outputFiles = await readdir(outputRoot)
      options.signal?.throwIfAborted()
      if (outputFiles.length === 1 && outputFiles[0] === "config.json" && isDeepStrictEqual(vercelConfig, createVercelConfigJson())) {
        await rm(configFile, { force: true })
        options.signal?.throwIfAborted()
        await removeEmptyDirectories(outputRoot, options.rootDir)
        publicationCompleted = true
        return
      }
    }
    options.signal?.throwIfAborted()
    await writeFile(configFile, `${JSON.stringify(vercelConfig, null, 2)}\n`, "utf8")
    options.signal?.throwIfAborted()
    await removeEmptyDirectories(outputRoot, options.rootDir)
    options.signal?.throwIfAborted()
    publicationCompleted = true
  }
  catch (error) {
    if (installedFunctionRoot) rmSync(functionRoot, { force: true, recursive: true })
    if (existsSync(backupFunctionRoot)) renameSync(backupFunctionRoot, functionRoot)
    if (previousConfig) await writeFile(configFile, previousConfig)
    else await rm(configFile, { force: true })
    throw error
  }
  finally {
    if (publicationCompleted) {
      try {
        rmSync(backupFunctionRoot, { force: true, recursive: true })
      }
      catch {}
    }
  }
}

export async function createNetlifyScheduleFunctionOutputs(options: {
  crons?: Map<string, string>
  definitions: DiscoveredScheduleDefinition[]
  functionRoot: string
  includedSourcesDir?: string
  registryFile: string
  timeZoneCrons?: ScheduleTimeZoneCrons
}): Promise<NetlifyScheduleFunctionOutput[]> {
  const definitions = options.definitions
  const crons = options.crons ?? await readDefinitionCrons(definitions)
  const timeZoneCrons = options.timeZoneCrons ?? readTimeZoneCrons(definitions)
  const functionNames = netlifyScheduleFunctionNames(definitions)
  return definitions.map((definition) => {
    const file = resolve(options.functionRoot, `${functionNames.get(definition.name)!}.mjs`)
    return {
      cron: crons.get(definition.name)!,
      file,
      name: definition.name,
      source: renderNetlifyScheduleFunction(file, options.registryFile, definition.name, crons.get(definition.name)!, options.includedSourcesDir, Object.hasOwn(timeZoneCrons, definition.name)),
    }
  })
}

async function writeNetlifyScheduleFunctions(options: {
  bundleAlias?: Record<string, string>
  bundleDefines?: Record<string, string>
  bundleExternal?: string[]
  crons: Map<string, string>
  sourceRootDir?: string
  definitions: DiscoveredScheduleDefinition[]
  outputRoot: string
  registryFile: string
  rootDir: string
  signal?: AbortSignal
  timeZoneCrons: ScheduleTimeZoneCrons
}) {
  options.signal?.throwIfAborted()
  const functionRoot = resolve(options.outputRoot, "functions")
  const publishedSourcesDir = resolve(dirname(options.registryFile), "sources")
  const netlifySourcesDir = resolve(options.outputRoot, "schedule", "sources")
  const includedSourcesDir = relative(functionRoot, netlifySourcesDir).replace(/\\/g, "/")
  const stagedOutputRoot = `${options.outputRoot}.pending`
  const backupOutputRoot = `${options.outputRoot}.previous`
  const stagedFunctionRoot = resolve(stagedOutputRoot, "functions")
  const stagedSourcesDir = resolve(stagedOutputRoot, "schedule", "sources")
  let preserveRecovery = false
  try {
    await rm(stagedOutputRoot, { force: true, recursive: true })
    await cp(options.outputRoot, stagedOutputRoot, { force: true, recursive: true, verbatimSymlinks: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await rm(stagedSourcesDir, { force: true, recursive: true })
    const existingFiles = await readdir(stagedFunctionRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))
    await Promise.all(existingFiles.filter(file => /^vitehub-schedule-.+\.mjs$/.test(file)).map(file => rm(resolve(stagedFunctionRoot, file), { force: true, recursive: true })))

    const outputs = await createNetlifyScheduleFunctionOutputs({
      crons: options.crons,
      definitions: options.definitions,
      functionRoot: stagedFunctionRoot,
      includedSourcesDir: existsSync(publishedSourcesDir) ? includedSourcesDir : undefined,
      registryFile: options.registryFile,
      timeZoneCrons: options.timeZoneCrons,
    })
    options.signal?.throwIfAborted()
    if (outputs.length === 0) {
      await mkdir(stagedFunctionRoot, { recursive: true })
    }
    else {
      await mkdir(stagedFunctionRoot, { recursive: true })
      options.signal?.throwIfAborted()
      const results = await Promise.allSettled(outputs.map(async (output) => {
        const wrapperFile = `${output.file}.source.mjs`
        await writeFile(wrapperFile, output.source, { encoding: "utf8", signal: options.signal })
        try {
          await bundleEsmEntry(wrapperFile, output.file, {
            alias: options.bundleAlias,
            define: options.bundleDefines,
            external: options.bundleExternal,
            format: "esm",
            platform: "node",
            plugins: [createScheduleDefinitionAliasPlugin()],
            rootDir: options.sourceRootDir ?? options.rootDir,
            signal: options.signal,
            workingDir: options.sourceRootDir ?? options.rootDir,
          })
        }
        finally {
          await rm(wrapperFile, { force: true })
        }
      }))
      const failure = results.find(result => result.status === "rejected")
      if (failure) throw failure.reason
    }
    await publishProviderSourcesToDeploymentOutputs({
      destinations: [{
        files: outputs.map(output => output.file),
        runtimeSourcesDir: relative(options.rootDir, netlifySourcesDir).replace(/\\/g, "/"),
        sourcesDir: stagedSourcesDir,
      }],
      publishedSourcesDir,
      signal: options.signal,
    })
    if (existsSync(stagedSourcesDir)) {
      await rebasePublishedProviderSourceLinks(stagedSourcesDir, stagedSourcesDir, netlifySourcesDir)
    }
    options.signal?.throwIfAborted()
    // Functions and retained sources must move together, including during recovery.
    rmSync(backupOutputRoot, { force: true, recursive: true })
    let movedPrevious = false
    try {
      if (existsSync(options.outputRoot)) {
        renameSync(options.outputRoot, backupOutputRoot)
        movedPrevious = true
      }
      renameSync(stagedOutputRoot, options.outputRoot)
    }
    catch (error) {
      if (movedPrevious) {
        try {
          renameSync(backupOutputRoot, options.outputRoot)
        }
        catch (restoreError) {
          // Retry a transient restore failure without deleting either complete pair.
          try {
            await rename(backupOutputRoot, options.outputRoot)
          }
          catch (retryError) {
            preserveRecovery = true
            throw new AggregateError([error, restoreError, retryError], `Netlify Schedule rollback failed; previous output retained at ${backupOutputRoot}`)
          }
        }
      }
      throw error
    }
    // Publication is committed. Cleanup must not turn successful output into a failed generation.
    await rm(backupOutputRoot, { force: true, recursive: true }).catch(() => undefined)
    if (outputs.length === 0) await removeEmptyDirectories(functionRoot, options.rootDir).catch(() => undefined)
  }
  finally {
    if (!preserveRecovery) await rm(stagedOutputRoot, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function writeCloudflareScheduleOutput(options: {
  bundleDefines?: Record<string, string>
  bundleAlias?: Record<string, string>
  bundleEntry: string
  crons: string[]
  rootDir: string
  previousStateFile?: string
  stateFile: string
  signal?: AbortSignal
  sourceRootDir?: string
}) {
  options.signal?.throwIfAborted()
  const outputRoot = createDefaultCloudflareOutputRoot(options.rootDir)
  await mkdir(outputRoot, { recursive: true })

  const configFile = resolve(outputRoot, "wrangler.json")
  let wranglerConfig: Record<string, unknown> = {}
  try {
    wranglerConfig = JSON.parse(await readFile(configFile, "utf8"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const existingTriggers = isRecord(wranglerConfig.triggers)
    ? wranglerConfig.triggers
    : {}
  const previousState = await readCloudflareOutputState(options.previousStateFile ?? options.stateFile)
  options.signal?.throwIfAborted()
  const existingCrons = readStringArray(existingTriggers.crons)
  const externalCrons = existingCrons.filter(cron => !previousState?.crons.includes(cron))
  const ownedCrons = options.crons.filter(cron => !externalCrons.includes(cron))
  const main = typeof wranglerConfig.main === "string" && wranglerConfig.main
    ? wranglerConfig.main
    : "index.js"
  wranglerConfig = {
    ...wranglerConfig,
    compatibility_date: wranglerConfig.compatibility_date ?? defaultCloudflareCompatibilityDate,
    compatibility_flags: wranglerConfig.compatibility_flags ?? ["nodejs_compat"],
    main,
    observability: wranglerConfig.observability ?? { enabled: true },
    triggers: {
      ...existingTriggers,
      crons: [...new Set([...externalCrons, ...options.crons])],
    },
  }

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, resolve(outputRoot, main), {
      alias: options.bundleAlias,
      define: options.bundleDefines,
      banner: `// ${cloudflareScheduleWorkerMarker}`,
      conditions: ["workerd", "worker", "browser", "default"],
      external: [cloudflareRuntimeExternal, "node:*"],
      format: "esm",
      platform: "neutral",
      plugins: [createScheduleDefinitionAliasPlugin()],
      rootDir: options.sourceRootDir ?? options.rootDir,
      signal: options.signal,
    }),
    writeFile(configFile, `${JSON.stringify(wranglerConfig, null, 2)}\n`, { encoding: "utf8", signal: options.signal }),
    writeFile(options.stateFile, `${JSON.stringify({ crons: ownedCrons, main }, null, 2)}\n`, { encoding: "utf8", signal: options.signal }),
  ])
  await publishProviderSourcesToDeploymentOutputs({
    destinations: [{
      files: [resolve(outputRoot, main)],
      runtimeSourcesDir: `./${deployedScheduleSourcesPath}`,
      sourcesDir: resolve(outputRoot, deployedScheduleSourcesPath),
    }],
    publishedSourcesDir: resolve(dirname(options.bundleEntry), "sources"),
    signal: options.signal,
  })
}

interface CloudflareOutputState {
  crons: string[]
  main: string
}

async function readCloudflareOutputState(file: string): Promise<CloudflareOutputState | undefined> {
  let source: string
  try {
    source = await readFile(file, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    const state = JSON.parse(source) as Partial<CloudflareOutputState>
    if (!Array.isArray(state.crons) || state.crons.some(cron => typeof cron !== "string") || typeof state.main !== "string" || !state.main) return
    return { crons: state.crons, main: state.main }
  }
  catch {
    return
  }
}

async function cleanCloudflareScheduleOutput(rootDir: string, stateFile: string, previousStateFile = stateFile): Promise<void> {
  const state = await readCloudflareOutputState(previousStateFile)
  if (!state) return
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  const configFile = resolve(outputRoot, "wrangler.json")
  const workerFile = resolve(outputRoot, state.main)
  let ownsWorker = false
  try {
    ownsWorker = (await readFile(workerFile, "utf8")).includes(cloudflareScheduleWorkerMarker)
  }
  catch (error) {
    // SAFETY: Node.js filesystem rejections expose errno codes through NodeJS.ErrnoException.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let configSource: string | undefined
  try {
    configSource = await readFile(configFile, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (configSource !== undefined) {
    const config = JSON.parse(configSource) as Record<string, unknown>
    const triggers = typeof config.triggers === "object" && config.triggers !== null
      ? config.triggers as Record<string, unknown>
      : undefined
    const crons = Array.isArray(triggers?.crons)
      ? triggers.crons.filter((cron): cron is string => typeof cron === "string" && !state.crons.includes(cron))
      : []
    if (triggers) {
      config.triggers = { ...triggers, crons }
    }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  }
  await Promise.all([
    ...(ownsWorker ? [rm(workerFile, { force: true })] : []),
    rm(resolve(outputRoot, deployedScheduleSourcesPath), { force: true, recursive: true }),
    rm(stateFile, { force: true }),
  ])
}

export async function generateProviderOutputsWithinLock(options: GenerateProviderOutputsOptions): Promise<GeneratedScheduleArtifacts> {
  // Restore the complete Netlify publication before any generation work can fail or abort.
  recoverNetlifyDeploymentOutput(options.rootDir)
  options.signal?.throwIfAborted()
  const generatedDir = resolve(options.rootDir, ".vitehub", productName)
  const previousGeneratedDir = `${generatedDir}.${randomUUID()}.previous`
  const coordinatesRetainedSources = options.retainedSourcesDir !== undefined
  const hadPreviousGeneratedDir = coordinatesRetainedSources && existsSync(generatedDir)
  if (hadPreviousGeneratedDir) await rename(generatedDir, previousGeneratedDir)
  const cloudflareStateFile = resolve(generatedDir, cloudflareOutputStateFileName)
  const previousCloudflareStateFile = hadPreviousGeneratedDir
    ? resolve(previousGeneratedDir, cloudflareOutputStateFileName)
    : cloudflareStateFile
  let publicationSettled = !coordinatesRetainedSources
  try {
    let artifacts = await writeProviderEntries(options.rootDir, options.source, options.definitions, options.cron)
    if (options.retainedSourcesDir && artifacts.definitions.length > 0) {
      artifacts = await publishRetainedProviderSources(artifacts, options.retainedSourcesDir, options.signal)
    }
    options.signal?.throwIfAborted()
    const discoveredCrons = options.crons ?? await readDefinitionCrons(artifacts.definitions, options.cron)
    const crons = new Map(artifacts.definitions.map(definition => [definition.name, discoveredCrons.get(definition.name)!]))
    const timeZoneCrons = readTimeZoneCrons(artifacts.definitions, options.cron)
    // Other hosts get the same cleanup as a build without Schedules, so their stale Schedule output goes away.
    const hostDefinitions = (host: ViteHubHost) => options.host === undefined || options.host === host ? artifacts.definitions : []
    options.signal?.throwIfAborted()
    if (hostDefinitions("deno").length > 0) {
      const stagedDenoCronInputFile = `${artifacts.denoCronFile}.vitehub-input-tmp.mjs`
      const stagedDenoCronFile = `${artifacts.denoCronFile}.vitehub-tmp`
      try {
        await writeFile(stagedDenoCronInputFile, renderDenoCronEntry(artifacts.denoCronFile, artifacts.registryFile, crons, options.runtimeImport, timeZoneCrons), "utf8")
        await bundleEsmEntry(stagedDenoCronInputFile, stagedDenoCronFile, {
          alias: options.bundleAlias,
          define: options.bundleDefines,
          external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), ...(options.bundleExternal ?? [])],
          format: "esm",
          packages: "external",
          platform: "neutral",
          plugins: [createScheduleDefinitionAliasPlugin()],
          rootDir: options.sourceRootDir ?? options.rootDir,
          signal: options.signal,
        })
        await rename(stagedDenoCronFile, artifacts.denoCronFile)
      }
      finally {
        await Promise.all([
          rm(stagedDenoCronInputFile, { force: true }),
          rm(stagedDenoCronFile, { force: true }),
        ])
      }
    }
    else {
      await rm(artifacts.denoCronFile, { force: true })
    }
    options.signal?.throwIfAborted()
    if (hostDefinitions("cloudflare").length > 0) {
      await writeCloudflareScheduleOutput({
        bundleAlias: options.bundleAlias,
        bundleDefines: options.bundleDefines,
        bundleEntry: artifacts.cloudflareWorkerFile,
        crons: [...new Set(crons.values())],
        rootDir: options.rootDir,
        previousStateFile: previousCloudflareStateFile,
        sourceRootDir: options.sourceRootDir,
        stateFile: cloudflareStateFile,
        signal: options.signal,
      })
    }
    else {
      await cleanCloudflareScheduleOutput(options.rootDir, cloudflareStateFile, previousCloudflareStateFile)
    }
    if (artifacts.definitions.length === 0) {
      options.signal?.throwIfAborted()
      await Promise.all([
        rm(artifacts.cloudflareWorkerFile, { force: true }),
        rm(artifacts.registryFile, { force: true }),
        rm(artifacts.vercelServerFile, { force: true }),
      ])
    }
    options.signal?.throwIfAborted()
    await writeVercelScheduleFunctions({
      bundleAlias: options.bundleAlias,
      bundleDefines: options.bundleDefines,
      bundleExternal: options.bundleExternal,
      definitions: hostDefinitions("vercel"),
      outputRoot: createDefaultVercelOutputRoot(options.rootDir),
      registryFile: artifacts.registryFile,
      rootDir: options.rootDir,
      signal: options.signal,
      sourceRootDir: options.sourceRootDir,
      timeZoneCrons,
      workflow: options.workflow,
    }, crons)
    options.signal?.throwIfAborted()
    await writeNetlifyScheduleFunctions({
      bundleAlias: options.bundleAlias,
      bundleDefines: options.bundleDefines,
      bundleExternal: options.bundleExternal,
      crons,
      sourceRootDir: options.sourceRootDir,
      definitions: hostDefinitions("netlify"),
      outputRoot: createDefaultNetlifyOutputRoot(options.rootDir),
      registryFile: artifacts.registryFile,
      rootDir: options.rootDir,
      signal: options.signal,
      timeZoneCrons,
    })
    publicationSettled = true
    if (hadPreviousGeneratedDir) await removeProviderOutputArtifactDir(previousGeneratedDir).catch(() => undefined)
    return artifacts
  }
  catch (error) {
    if (!publicationSettled) {
      try {
        await removeProviderOutputArtifactDir(generatedDir)
        if (hadPreviousGeneratedDir) await rename(previousGeneratedDir, generatedDir)
        publicationSettled = true
      }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], "Generated Schedule artifact rollback failed")
      }
    }
    throw error
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedScheduleArtifacts> {
  return await withProviderDeploymentOutputLock(options.rootDir, async () => await generateProviderOutputsWithinLock(options))
}
