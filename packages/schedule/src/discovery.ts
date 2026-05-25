import { readFileSync } from "node:fs"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"
import {
  findIdentifierCalls,
  splitTopLevel,
} from "@vitehub/internal/source-scanner"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function isExportDefaultCall(source: string, start: number) {
  return /(?:^|[^\w$])export\s+default(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$)|\()*$/.test(source.slice(0, start))
}

function readDefaultExportIdentifier(source: string) {
  return source.match(/\bexport\s+default(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))+([A-Za-z_$][\w$]*)\b(?!\s*(?:<|\())/)?.[1]
}

function readDefineScheduleBindingName(source: string, start: number) {
  return source.slice(0, start).match(/(?:^|[;\n])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*(?:\n|$)\s*)*$/)?.[1]
}

function readDefineScheduleOptions(source: string): string | undefined {
  const calls = findIdentifierCalls(source, "defineSchedule")
  const directExportCall = calls.find(call => isExportDefaultCall(source, call.start))
  if (directExportCall) return directExportCall.arguments[2]

  const defaultExportName = readDefaultExportIdentifier(source)
  const defaultExportBindingCall = defaultExportName
    ? calls.find(call => readDefineScheduleBindingName(source, call.start) === defaultExportName)
    : undefined
  return (defaultExportBindingCall ?? calls[0])?.arguments[2]
}

function stripBoundaryComments(source: string) {
  return source
    .replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .replace(/(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+$/, "")
}

function readTopLevelStringProperty(source: string, property: string): string | undefined {
  const objectSource = stripBoundaryComments(source)
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return undefined

  for (const entry of splitTopLevel(objectSource.slice(1, -1))) {
    const [key, ...valueParts] = splitTopLevel(entry, ":")
    const normalizedKey = stripBoundaryComments(key ?? "").replace(/^(['"])(.*)\1$/, "$2")
    if (normalizedKey !== property) continue
    const value = stripBoundaryComments(valueParts.join(":"))
    const match = value.match(/^(['"])((?:\\.|(?!\1).)*)\1$/)
    if (match) {
      return match[2]?.replace(/\\(.)/g, "$1")
    }
  }
}

function stripBoundaryComments(source: string) {
  return source
    .replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .replace(/(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+$/, "")
}

function readTopLevelBooleanProperty(source: string, property: string): boolean | undefined {
  const objectSource = source.trim()
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return undefined

  for (const entry of splitTopLevel(objectSource.slice(1, -1))) {
    const [key, ...valueParts] = splitTopLevel(entry, ":")
    const normalizedKey = stripBoundaryComments(key ?? "").replace(/^(['"])(.*)\1$/, "$2")
    if (normalizedKey !== property) continue
    const value = stripBoundaryComments(valueParts.join(":"))
    if (value === "true") return true
    if (value === "false") return false
  }
}

function readScheduleIdOverride(file: string): string | undefined {
  const options = readDefineScheduleOptions(readFileSync(file, "utf8"))
  return options ? readTopLevelStringProperty(options, "id") : undefined
}

function readAllowRuntimeSchedules(file: string): boolean {
  const options = readDefineScheduleOptions(readFileSync(file, "utf8"))
  return options ? readTopLevelBooleanProperty(options, "allowRuntimeSchedules") === true : false
}

function createDiscoveredScheduleDefinition(source: DiscoveredScheduleDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredScheduleDefinition => ({
    allowRuntimeSchedules: readAllowRuntimeSchedules(context.file),
    handler: context.file,
    name: context.name,
    source,
  })
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
    return discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("nitro-server-schedules", options.scanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("nitro-server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
  }

  return discoverDefinitions("schedule", [
    createSuffixDefinitionSource("vite-suffix", resolveDefinitionScanRoots(options.rootDir, options.scanDirs), scheduleSuffixPattern, normalizeSuffixScheduleName, {
      createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
    }),
  ])
}
