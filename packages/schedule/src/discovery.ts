import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { findCalls, findDefaultExportCall, objectProperties, scanModule } from "@vite-hub/internal/build/scan-module"

import { describeScheduleContribution, duplicateScheduleError } from "./contributions.ts"
import { startedSchedulesTickName } from "./runtime/started-name.ts"

import type { CollectedScheduleContribution } from "./contributions.ts"
import type { DiscoveredScheduleDefinition } from "./types.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

/** Discovery source of Schedule Definitions that Vite plugins contribute through `vitehub.schedules`. */
export const contributedScheduleSource = "vite-plugin-contribution"

/**
 * Whether a Definition is a server Schedule: a `server/schedules/` file or a contribution. Server Schedules share one
 * delivery path, for example the generated Nitro wake plugin when `providerOutput` is `auto`.
 */
export function isServerScheduleDefinition(definition: Pick<DiscoveredScheduleDefinition, "source">): boolean {
  return definition.source === "server-schedules" || definition.source === contributedScheduleSource
}

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function readScheduleDiscoveryMetadata(file: string, contribution?: string): Pick<DiscoveredScheduleDefinition, "manual" | "startable"> {
  const source = readFileSync(file, "utf8")
  const module = scanModule(source, file)
  const definition = findDefaultExportCall(module, ["defineSchedule"])
  const unsupported = (offset: number, message: string): never => {
    const line = source.slice(0, offset).split("\n").length
    throw scheduleErrorDiagnostics.SCHEDULE_B0005({ message: `[vitehub] ${file}:${line}: ${message}` })
  }
  if (!definition) {
    const call = findCalls(module, ["defineSchedule"])[0]
    const message = "Schedule discovery requires a direct default export of defineSchedule() with literal options."
    if (call && call.arguments.length > 1) {
      const line = source.slice(0, call.start).split("\n").length
      throw scheduleErrorDiagnostics.SCHEDULE_C0007({ message: `[vitehub] ${file}:${line}: \`defineSchedule(cron, handler)\` was removed. Write \`export default defineSchedule({ cron: "...", handler })\`.` })
    }
    if (call) unsupported(call.start, message)
    // A syntax error can hide the definition call, so the file cannot prove that it has no Schedule.
    if (module.errors[0]) unsupported(0, `${message} The file has a syntax error: ${module.errors[0].message}`)
    if (contribution) {
      throw scheduleErrorDiagnostics.SCHEDULE_B0005({ message: `[vitehub] ${contribution} has no default export of defineSchedule(). The build reads contributed Schedules from source, so the module must contain \`export default defineSchedule({ cron: "...", handler })\`.` })
    }
    return {}
  }

  const start = definition.call.start
  let manual = false
  let startable = true
  for (const property of definition.options ? objectProperties(definition.options) : []) {
    if (property.key === undefined || property.computed) {
      unsupported(start, "Schedule discovery cannot resolve spread, computed, or escaped option keys. Declare manual with an unescaped literal key and a literal true or false value.")
    }
    if (property.key === "cron") startable = false
    if (property.key !== "manual") continue
    const value = property.node.type === "Property" && property.node.kind === "init" && !property.node.method && property.value?.type === "Literal" && typeof property.value.value === "boolean"
      ? property.value.value
      : undefined
    if (value === undefined) unsupported(start, "Schedule discovery requires manual to be a literal true or false; it cannot evaluate this expression.")
    manual = value === true
  }
  return startable ? { manual, startable } : { manual }
}

function createDiscoveredScheduleDefinition(source: DiscoveredScheduleDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredScheduleDefinition => {
    const metadata = readScheduleDiscoveryMetadata(context.file)
    return {
      ...metadata,
      handler: context.file,
      name: context.name,
      source,
    }
  }
}

function normalizeSuffixScheduleName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, scheduleSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryScheduleName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file)
}

function createContributedScheduleDefinition(contribution: CollectedScheduleContribution): DiscoveredScheduleDefinition {
  const file = contribution.definition.module
  if (!existsSync(file)) {
    throw scheduleErrorDiagnostics.SCHEDULE_B0007({ message: `[vitehub] ${describeScheduleContribution(contribution)} adds Schedule "${contribution.name}", but the Definition module does not exist.` })
  }
  const definition: DiscoveredScheduleDefinition = {
    ...readScheduleDiscoveryMetadata(file, describeScheduleContribution(contribution)),
    contributor: contribution.plugin,
    handler: file,
    name: contribution.name,
    source: contributedScheduleSource,
  }
  if (contribution.reason) definition.reason = contribution.reason
  return definition
}

function mergeContributedScheduleDefinitions(
  discovered: DiscoveredScheduleDefinition[],
  contributions: readonly CollectedScheduleContribution[] | undefined,
): DiscoveredScheduleDefinition[] {
  if (!contributions?.length) return discovered
  const definitions = new Map(discovered.map(definition => [definition.name, definition]))
  for (const contribution of contributions) {
    const existing = definitions.get(contribution.name)
    if (existing) {
      const first = existing.source === contributedScheduleSource
        ? describeScheduleContribution({ definition: { export: "default", module: existing.handler }, plugin: existing.contributor ?? "unnamed plugin" })
        : existing.handler
      throw duplicateScheduleError(contribution.name, first, describeScheduleContribution(contribution))
    }
    definitions.set(contribution.name, createContributedScheduleDefinition(contribution))
  }
  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export interface ScheduleDiscoveryOptions {
  /** Schedule Definitions that Vite plugins contribute. See `collectScheduleContributions()`. */
  contributions?: readonly CollectedScheduleContribution[]
  mode?: "vite-suffix"
  rootDir: string
  scanDirs?: string[]
  serverDirs?: string[]
  serverRootDir?: string
}

type DiscoverScheduleDefinitionsOptions =
  | ScheduleDiscoveryOptions
  | { mode: "server-schedules", scanDirs: string[] }

function discoverAllScheduleDefinitions(options: DiscoverScheduleDefinitionsOptions): DiscoveredScheduleDefinition[] {
  if (options.mode === "server-schedules") {
    return discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("server-schedules", options.scanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverRoots = resolveDefinitionScanRoots(options.serverRootDir || options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? serverRoots.map(root => resolve(root, "server"))

  for (const directory of serverScanDirs) {
    if (roots.every((root) => {
      const path = relative(resolve(root), resolve(directory))
      return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
    })) {
      roots.push(directory)
    }
  }

  return mergeContributedScheduleDefinitions(mergeDefinitions(
    "schedule",
    discoverDefinitions("schedule", [
      createSuffixDefinitionSource("vite-suffix", roots, scheduleSuffixPattern, normalizeSuffixScheduleName, {
        createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
      }),
    ]).filter(definition => !serverScanDirs.some((directory) => {
      const path = relative(resolve(directory, "schedules"), definition.handler)
      return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    })),
    discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("server-schedules", serverScanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ]),
  ), options.contributions)
}

const startedTickFile = ".vitehub/schedule-started/tick.mjs"

function startedTickSource(): string {
  // Absolute paths, because the module is in the project and the app may not install the owner package by its name.
  const resolveEntry = (specifier: string) => JSON.stringify(fileURLToPath(import.meta.resolve(specifier)).replace(/\\/g, "/"))
  return [
    "// Generated by @vite-hub/schedule. Runs the Schedules that code starts with startSchedule(), each minute.",
    `import { defineSchedule } from ${resolveEntry("@vite-hub/schedule")}`,
    `import { runStartedSchedules } from ${resolveEntry("@vite-hub/schedule/runtime")}`,
    "",
    "export default defineSchedule({ cron: \"* * * * *\", handler: runStartedSchedules, manual: true })",
    "",
  ].join("\n")
}

/**
 * The Schedule that wakes started Schedules. It is a plain Schedule with `* * * * *`, so each host wakes it the way it
 * wakes any Schedule: a Cron Trigger on Cloudflare, the Process Runtime on Node. The build reads its cron from source, so
 * the module is a file in the project.
 */
function startedTickDefinition(rootDir: string): DiscoveredScheduleDefinition {
  const file = resolve(rootDir, startedTickFile)
  const source = startedTickSource()
  if (!existsSync(file) || readFileSync(file, "utf8") !== source) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return {
    contributor: "@vite-hub/schedule",
    handler: file,
    manual: true,
    name: startedSchedulesTickName,
    reason: "Runs the Schedules that code starts with startSchedule(). It exists because a Schedule Definition has no cron.",
    source: contributedScheduleSource,
  }
}

function discoveryRoot(options: DiscoverScheduleDefinitionsOptions): string | undefined {
  return "rootDir" in options ? options.serverRootDir || options.rootDir : undefined
}

/**
 * Discovers the Schedule Definitions that run on a cron. When a Definition has no `cron`, it adds the
 * `vitehub/started-schedules` Schedule, which runs the Schedules that code starts with `startSchedule()`.
 * `discoverStartableScheduleDefinitions()` lists the Definitions without `cron`.
 */
export function discoverScheduleDefinitions(options: DiscoverScheduleDefinitionsOptions): DiscoveredScheduleDefinition[] {
  const definitions = discoverAllScheduleDefinitions(options)
  const cronDefinitions = definitions.filter(definition => !definition.startable)
  const root = discoveryRoot(options)
  if (cronDefinitions.length === definitions.length || !root) return cronDefinitions
  const taken = cronDefinitions.find(definition => definition.name === startedSchedulesTickName)
  if (taken) throw duplicateScheduleError(startedSchedulesTickName, taken.handler, "@vite-hub/schedule")
  return [...cronDefinitions, startedTickDefinition(root)].sort((left, right) => left.name.localeCompare(right.name))
}

/** Discovers the Schedule Definitions without `cron`. Only `startSchedule()` runs them. */
export function discoverStartableScheduleDefinitions(options: DiscoverScheduleDefinitionsOptions): DiscoveredScheduleDefinition[] {
  return discoverAllScheduleDefinitions(options).filter(definition => definition.startable)
}
