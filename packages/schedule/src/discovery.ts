import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i
const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const agentConfigPattern = /^config\.(?:c|m)?[jt]s$/i
const sourceFileExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]
const ignoredViteInlineAgentScheduleDirs = new Set(["build", "coverage", "dist", "node_modules", ".output", ".vercel"])

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function normalizeScheduleCron(cron: string): string {
  return cron.trim().replace(/\s+/g, " ")
}

function scheduleIdFromCron(cron: string): string {
  return `schedule-${normalizeScheduleCron(cron).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`
}

function isInlineScheduleObjectKey(source: string, stringEnd: number): boolean {
  return /^\s*:/.test(source.slice(stringEnd))
}

function isInlineScheduleObjectValue(source: string, stringStart: number): boolean {
  return /(?:^|[,{]\s*)(["'`])?(?:cron|id)\1?\s*:\s*$/u.test(source.slice(Math.max(0, stringStart - 24), stringStart))
}

function readScheduleIdOverride(file: string): string | undefined {
  const source = readFileSync(file, "utf8")
  const match = source.match(/\bdefineSchedule\s*(?:<[^>]+>\s*)?\([\s\S]*?,[\s\S]*?,\s*\{[\s\S]*?\bid\s*:\s*(["'])([^"']+)\1/)
  return match?.[2]
}

function readAllowRuntimeSchedules(file: string): boolean {
  const source = readFileSync(file, "utf8")
  return /\bdefineSchedule\s*(?:<[^>]+>\s*)?\([\s\S]*?,[\s\S]*?,\s*\{[\s\S]*?\ballowRuntimeSchedules\s*:\s*true\b/.test(source)
}

function createDiscoveredScheduleDefinition(source: DiscoveredScheduleDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredScheduleDefinition => ({
    allowRuntimeSchedules: readAllowRuntimeSchedules(context.file),
    handler: context.file,
    name: context.name,
    source,
  })
}

function parseInlineAgentScheduleEntries(source: string): Array<{ cron: string, id: string }> {
  const stripped = stripComments(source)
  const entries: Array<{ cron: string, id: string }> = []
  const schedulesPattern = /\bschedule\s*\(\s*\{[\s\S]*?\bschedules\s*:\s*\[([\s\S]*?)\][\s\S]*?\}\s*\)/g
  for (const match of stripped.matchAll(schedulesPattern)) {
    const body = match[1]!
    for (const stringEntry of body.matchAll(/(["'`])([^"'`]+)\1/g)) {
      if (isInlineScheduleObjectKey(body, stringEntry.index! + stringEntry[0].length)) continue
      if (isInlineScheduleObjectValue(body, stringEntry.index!)) continue
      const cron = normalizeScheduleCron(stringEntry[2]!)
      entries.push({ cron, id: scheduleIdFromCron(cron) })
    }
    for (const objectEntry of body.matchAll(/\{[\s\S]*?(["'`])?cron\1?\s*:\s*(["'`])([^"'`]+)\2[\s\S]*?\}/g)) {
      const objectSource = objectEntry[0]
      const cron = normalizeScheduleCron(objectEntry[3]!)
      const id = objectSource.match(/(["'`])?id\1?\s*:\s*(["'`])([^"'`]+)\2/)?.[3] || scheduleIdFromCron(cron)
      entries.push({ cron, id })
    }
  }
  return entries
}

function inlineAgentSchedules(file: string, agentName: string, agentExportName?: string): DiscoveredScheduleDefinition[] {
  return parseInlineAgentScheduleEntries(readFileSync(file, "utf8")).map(schedule => ({
    agentExportName,
    agentName,
    cron: schedule.cron,
    handler: file,
    name: `${agentName}/${schedule.id}`,
    source: "agent-inline-schedule" as const,
  }))
}

function parseAgentName(source: string): string | undefined {
  return stripComments(source).match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/)?.[1]
}

function discoverNamedAgentExports(file: string): Array<{ exportName: string, name: string }> {
  const source = stripComments(readFileSync(file, "utf8"))
  const definitions: Array<{ exportName: string, name: string }> = []
  for (const match of source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*defineAgent\s*\(\s*\{/g)) {
    definitions.push({ exportName: match[1]!, name: match[1]! })
  }
  return definitions
}

function discoverViteInlineAgentSchedules(rootDir: string, scanDirs?: string[]): DiscoveredScheduleDefinition[] {
  const roots = resolveDefinitionScanRoots(rootDir, scanDirs)
  const definitions: DiscoveredScheduleDefinition[] = []
  const walk = (root: string, current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const file = resolve(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !ignoredViteInlineAgentScheduleDirs.has(entry.name)) {
        walk(root, file)
        continue
      }
      if (!entry.isFile() || !agentSuffixPattern.test(basename(file))) continue
      const name = normalizeSuffixDefinitionName(root, file, agentSuffixPattern, { stripPrefix: "src/" })
      if (name && !name.startsWith("server/")) definitions.push(...inlineAgentSchedules(file, name))
    }
  }
  for (const root of roots) walk(root, root)
  return definitions
}

function discoverNitroInlineAgentSchedules(scanDirs: string[]): DiscoveredScheduleDefinition[] {
  const definitions: DiscoveredScheduleDefinition[] = []
  for (const scanDir of scanDirs) {
    const aggregateFiles = sourceFileExtensions
      .map(extension => resolve(scanDir, `agent${extension}`))
      .filter(file => existsSync(file))
    for (const file of aggregateFiles) {
      for (const agent of discoverNamedAgentExports(file)) {
        definitions.push(...inlineAgentSchedules(file, agent.name, agent.exportName))
      }
    }

    const agentsRoot = resolve(scanDir, "agents")
    const walk = (current: string) => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
      for (const entry of entries) {
        const file = resolve(current, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          walk(file)
          continue
        }
        if (!entry.isFile()) continue
        if (agentConfigPattern.test(basename(file))) {
          const source = readFileSync(file, "utf8")
          const agentName = parseAgentName(source) || relative(agentsRoot, dirname(file)).replace(/\\/g, "/")
          if (agentName && agentName !== ".") definitions.push(...inlineAgentSchedules(file, agentName))
          continue
        }
        if (/\.(?:c|m)?[jt]s$/i.test(basename(file))) {
          const agentName = relative(agentsRoot, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, "").replace(/\\/g, "/")
          definitions.push(...inlineAgentSchedules(file, agentName))
        }
      }
    }
    walk(agentsRoot)
  }
  return definitions
}

function normalizeSuffixScheduleName(rootDir: string, file: string) {
  return readScheduleIdOverride(file)
    ?? normalizeSuffixDefinitionName(rootDir, file, scheduleSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryScheduleName(directory: string, file: string) {
  return readScheduleIdOverride(file) ?? normalizePathDefinitionName(directory, file)
}

export function discoverScheduleDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-schedules", scanDirs: string[] }
): DiscoveredScheduleDefinition[] {
  if (options.mode === "nitro-server-schedules") {
    const fileDefinitions = discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("nitro-server-schedules", options.scanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("nitro-server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
    return mergeDefinitions("schedule", fileDefinitions, discoverNitroInlineAgentSchedules(options.scanDirs))
  }

  const fileDefinitions = discoverDefinitions("schedule", [
    createSuffixDefinitionSource("vite-suffix", resolveDefinitionScanRoots(options.rootDir, options.scanDirs), scheduleSuffixPattern, normalizeSuffixScheduleName, {
      createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
    }),
  ])
  return mergeDefinitions("schedule", fileDefinitions, discoverViteInlineAgentSchedules(options.rootDir, options.scanDirs))
}
