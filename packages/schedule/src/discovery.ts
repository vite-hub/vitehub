import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source: string, index: number): number {
  const close = source.indexOf("*/", index + 2)
  return close === -1 ? source.length : close + 2
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

function skipIgnorable(source: string, index: number): number {
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index)
      continue
    }
    break
  }
  return index
}

function previousSignificantToken(source: string, index: number): string {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1
  if (cursor < 0) return ""

  const wordEnd = cursor + 1
  while (cursor >= 0 && /[$\w]/.test(source[cursor]!)) cursor -= 1
  if (cursor < wordEnd - 1) return source.slice(cursor + 1, wordEnd)

  return source[cursor]!
}

function canStartRegexLiteral(source: string, index: number): boolean {
  const token = previousSignificantToken(source, index)
  return token === ""
    || token === "await"
    || token === "case"
    || token === "delete"
    || token === "return"
    || token === "throw"
    || token === "typeof"
    || token === "void"
    || /^[({[=,:;!&|?+\-*%^~<>]$/.test(token)
}

function skipRegexLiteral(source: string, index: number): number {
  let inCharacterClass = false
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === "\\") {
      cursor += 1
      continue
    }
    if (char === "[") {
      inCharacterClass = true
      continue
    }
    if (char === "]") {
      inCharacterClass = false
      continue
    }
    if (char === "/" && !inCharacterClass) {
      cursor += 1
      while (/[a-z]/i.test(source[cursor] ?? "")) cursor += 1
      return cursor
    }
  }
  return source.length
}

function isInsideNonCode(source: string, targetIndex: number): boolean {
  for (let index = 0; index < targetIndex; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      const quotedEnd = skipQuoted(source, index)
      if (targetIndex < quotedEnd) return true
      index = quotedEnd - 1
      continue
    }
    if (source.startsWith("//", index)) {
      const commentEnd = skipLineComment(source, index)
      if (targetIndex < commentEnd) return true
      index = commentEnd - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = skipBlockComment(source, index)
      if (targetIndex < commentEnd) return true
      index = commentEnd - 1
    }
  }
  return false
}

function readBalancedObject(source: string, openIndex: number): string | undefined {
  if (source[openIndex] !== "{") return undefined

  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index) - 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && canStartRegexLiteral(source, index)) {
      index = skipRegexLiteral(source, index) - 1
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
}

function splitTopLevelProperties(source: string): string[] {
  const properties: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index) - 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && canStartRegexLiteral(source, index)) {
      index = skipRegexLiteral(source, index) - 1
      continue
    }
    if (char === "{" || char === "[" || char === "(") depth += 1
    if (char === "}" || char === "]" || char === ")") depth -= 1
    if (char === "," && depth === 0) {
      properties.push(source.slice(start, index))
      start = index + 1
    }
  }

  properties.push(source.slice(start))
  return properties
}

function readTopLevelBooleanProperty(objectSource: string, propertyName: string): boolean | undefined {
  for (const property of splitTopLevelProperties(objectSource)) {
    const colon = property.indexOf(":")
    if (colon === -1) continue

    const key = stripBoundaryComments(property.slice(0, colon)).replace(/^["'`](.*)["'`]$/s, "$1")
    if (key !== propertyName) continue

    const value = stripBoundaryComments(property.slice(colon + 1))
    if (value === "true") return true
    if (value === "false") return false
  }
}

function stripBoundaryComments(source: string): string {
  return source
    .replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .replace(/(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+$/, "")
}

function findTypeParametersEnd(source: string, index: number): number {
  let depth = 0
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === "<") depth += 1
    if (char === ">" && source[cursor - 1] === "=") continue
    if (char === ">") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

interface ParsedScheduleDefinition {
  objectSource: string
  runtimeOnly: boolean
}

function readDefineScheduleObjectAfterDefault(source: string, index: number): ParsedScheduleDefinition | undefined {
  let cursor = skipIgnorable(source, index)
  let openParens = 0
  while (source[cursor] === "(") {
    openParens += 1
    cursor = skipIgnorable(source, cursor + 1)
  }

  const factory = source.startsWith("defineScheduleTarget", cursor)
    ? "defineScheduleTarget"
    : source.startsWith("defineSchedule", cursor)
      ? "defineSchedule"
      : undefined
  if (!factory) return undefined
  cursor += factory.length

  cursor = skipIgnorable(source, cursor)
  if (source[cursor] === "<") {
    const close = findTypeParametersEnd(source, cursor)
    if (close === -1) return undefined
    cursor = skipIgnorable(source, close + 1)
  }

  if (source[cursor] !== "(") return undefined
  cursor = skipIgnorable(source, cursor + 1)
  const objectSource = readBalancedObject(source, cursor)
  if (!objectSource) return undefined

  let afterObject = skipIgnorable(source, cursor + objectSource.length + 2)
  if (source[afterObject] === ")") afterObject = skipIgnorable(source, afterObject + 1)
  while (openParens > 0 && source[afterObject] === ")") {
    openParens -= 1
    afterObject = skipIgnorable(source, afterObject + 1)
  }
  return openParens === 0 ? { objectSource, runtimeOnly: factory === "defineScheduleTarget" } : undefined
}

function readDefaultDefineScheduleObject(source: string): ParsedScheduleDefinition | undefined {
  let match: RegExpExecArray | null
  const pattern = /\bexport\s+default\b/g
  while ((match = pattern.exec(source))) {
    if (isInsideNonCode(source, match.index)) continue
    const definition = readDefineScheduleObjectAfterDefault(source, match.index + match[0].length)
    if (definition) return definition
  }
}

function readScheduleDiscoveryMetadata(file: string): Pick<DiscoveredScheduleDefinition, "allowRuntimeSchedules" | "runtimeOnly"> {
  const definition = readDefaultDefineScheduleObject(readFileSync(file, "utf8"))
  if (!definition) return { allowRuntimeSchedules: false }
  if (definition.runtimeOnly) {
    return { allowRuntimeSchedules: true, runtimeOnly: true }
  }
  return { allowRuntimeSchedules: readTopLevelBooleanProperty(definition.objectSource, "allowRuntimeSchedules") === true }
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

export function discoverScheduleDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverRootDir?: string }
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
  const serverScanDirs = serverRoots.map(root => resolve(root, "server"))

  return mergeDefinitions(
    "schedule",
    discoverDefinitions("schedule", [
      createSuffixDefinitionSource("vite-suffix", roots, scheduleSuffixPattern, normalizeSuffixScheduleName, {
        createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
      }),
    ]),
    discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("server-schedules", serverScanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ]),
  )
}
