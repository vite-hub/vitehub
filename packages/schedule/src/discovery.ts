import { readFileSync } from "node:fs"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"

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

function readDefineScheduleObjectAfterDefault(source: string, index: number): string | undefined {
  let cursor = skipIgnorable(source, index)
  let openParens = 0
  while (source[cursor] === "(") {
    openParens += 1
    cursor = skipIgnorable(source, cursor + 1)
  }

  if (!source.startsWith("defineSchedule", cursor)) return undefined
  cursor += "defineSchedule".length

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
  return openParens === 0 ? objectSource : undefined
}

function readDefaultDefineScheduleObject(source: string): string | undefined {
  let match: RegExpExecArray | null
  const pattern = /\bexport\s+default\b/g
  while ((match = pattern.exec(source))) {
    if (isInsideNonCode(source, match.index)) continue
    const objectSource = readDefineScheduleObjectAfterDefault(source, match.index + match[0].length)
    if (objectSource) return objectSource
  }
}

function readAllowRuntimeSchedules(file: string): boolean {
  const objectSource = readDefaultDefineScheduleObject(readFileSync(file, "utf8"))
  return objectSource ? readTopLevelBooleanProperty(objectSource, "allowRuntimeSchedules") === true : false
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
  return normalizeSuffixDefinitionName(rootDir, file, scheduleSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryScheduleName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file)
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
