import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { createSourceScanner } from "@vite-hub/internal/source-scanner"

import { describeScheduleContribution, duplicateScheduleError } from "./contributions.ts"

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

function readScheduleDiscoveryMetadata(file: string, contribution?: string): Pick<DiscoveredScheduleDefinition, "manual"> {
  const source = readFileSync(file, "utf8")
  const { findDefaultExportCall, findIdentifierCalls, readObjectProperty, readObjectPropertyNames, splitTopLevel, stripBoundaryComments } = createSourceScanner(file)
  const definition = findDefaultExportCall(source, ["defineSchedule"], { positionalOptionsIndex: 2 })
  const unsupported = (offset: number, message: string): never => {
    const line = source.slice(0, offset).split("\n").length
    throw scheduleErrorDiagnostics.SCHEDULE_B0005({ message: `[vitehub] ${file}:${line}: ${message}` })
  }
  if (!definition) {
    const call = findIdentifierCalls(source, "defineSchedule")[0]
    if (call) unsupported(call.start, "Schedule discovery requires a direct default export of defineSchedule() with literal options.")
    if (contribution) {
      throw scheduleErrorDiagnostics.SCHEDULE_B0005({ message: `[vitehub] ${contribution} has no default export of defineSchedule(). The build reads contributed Schedules from source, so the module must contain \`export default defineSchedule({ cron: "...", handler })\`.` })
    }
    return {}
  }

  const options = definition.argument
  if (!options.startsWith("{") || !options.endsWith("}")) {
    unsupported(definition.start, "Schedule discovery requires an options object literal.")
  }
  let manual = false
  for (const entry of splitTopLevel(options.slice(1, -1))) {
    const property = stripBoundaryComments(entry)
    const names = readObjectPropertyNames(`{${property}}`)
    if (names.includes(undefined)) {
      unsupported(definition.start, "Schedule discovery cannot resolve spread, computed, or escaped option keys. Declare manual with an unescaped literal key and a literal true or false value.")
    }
    const manualValue = readObjectProperty(`{${property}}`, "manual")
    if (manualValue === "true" || manualValue === "false") manual = manualValue === "true"
    else if (names.includes("manual")) unsupported(definition.start, "Schedule discovery requires manual to be a literal true or false; it cannot evaluate this expression.")
  }
  return { manual }
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

export function discoverScheduleDefinitions(options:
  | ScheduleDiscoveryOptions
  | { mode: "server-schedules", scanDirs: string[] }
): DiscoveredScheduleDefinition[] {
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
