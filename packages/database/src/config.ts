import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createGeneratedDefinitionPath,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizeSuffixDefinitionName,
  sanitizeDefinitionFilename,
} from "@vite-hub/internal/definition-catalog"
import { findIdentifierCalls, findMatching, splitTopLevel } from "@vite-hub/internal/source-scanner"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { computePackageDir, resolveRuntimeModule } from "@vite-hub/internal/build/paths"

import { createRuntimeEnvConfigValue, resolveConfigValue, withConfigValueFallback } from "./config-value.ts"
import { cloudflareOptions, mergeCloudflareConfig, resolveCloudflareD1Binding, resolveCloudflareD1BindingName, resolveCloudflareHyperdriveBindingName } from "./internal/cloudflare.ts"

import type {
  CloudflareD1BindingConfig,
  CloudflareD1Projection,
  CloudflareD1HttpConfig,
  DatabaseConfigValue,
  DatabaseConnectionConfig,
  DatabaseDialect,
  DBModulePublicOptions,
  DiscoveredDatabaseDefinition,
  ResolvedCloudflareD1BindingConfig,
  ResolvedCloudflareHyperdriveConfig,
  ResolvedDBViteConfig,
  ResolvedDrizzleDatabaseConfig,
} from "./types.ts"

import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveDatabaseContributionTargets } from "./contributions.ts"

import type { CollectedDatabaseContribution } from "./contributions.ts"

export { resolveConfigValue } from "./config-value.ts"
export { resolveDefaultDatabase, type DefaultDatabaseResolution } from "./contributions.ts"

/** Serialize generated registries without invoking the legacy __proto__ setter. */
export function serializeGeneratedRegistry(value: unknown): string {
  return JSON.stringify(value).replace(/"__proto__":/g, '["__proto__"]:')
}

const configFilePattern = /^config\.(?:c|m)?[jt]s$/i
const viteDatabaseSuffixPattern = /\.database\.(?:c|m)?[jt]s$/i
const identifierPattern = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u
const identifierCapturePattern = "([$_\\u200C\\u200D\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*)"

function isLineTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029"
}

function readDefinitionObjectBody(file: string) {
  const source = readFileSync(file, "utf8")
  const maskedSource = maskCommentsAndStrings(source)
  const calls = findIdentifierCalls(source, "defineDatabase")
  // Search from the statement boundary rather than a fixed-size prefix. Long
  // comments or whitespace between `export default` and the call must not
  // cause the selector to fall back to an earlier decoy call.
  const call = calls.find(item => /(?:^|[;\n\r\u2028\u2029])\s*export\s+default\s*\(*$/.test(maskedSource.slice(0, item.start)))
    || calls[0]
  const argument = call?.arguments[0] ? stripExpressionComments(call.arguments[0]).trim() : undefined
  return objectLiteralBody(argument)
}

function objectLiteralBody(value: string | undefined) {
  let trimmed = value?.trim()
  for (;;) {
    if (trimmed) {
      trimmed = stripStaticTypeAssertions(trimmed)
      while (trimmed.endsWith("!")) trimmed = trimmed.slice(0, -1).trim()
    }
    if (trimmed?.startsWith("<")) {
      const closeIndex = findAngleAssertionClose(trimmed)
      if (closeIndex !== undefined) {
        trimmed = trimmed.slice(closeIndex + 1).trim()
        continue
      }
    }
    if (trimmed?.startsWith("(")) {
      const closeIndex = findMatching(trimmed, 0, "(", ")")
      if (closeIndex !== undefined) {
        const suffix = trimmed.slice(closeIndex + 1).trim()
        if (/^(?:as|satisfies)\b/.test(suffix)) {
          trimmed = trimmed.slice(0, closeIndex + 1).trim()
          continue
        }
        if (closeIndex === trimmed.length - 1) {
          trimmed = trimmed.slice(1, -1).trim()
          continue
        }
      }
    }
    if (trimmed?.startsWith("{")) {
      const closeIndex = findMatching(trimmed, 0, "{", "}")
      const suffix = closeIndex === undefined ? undefined : trimmed.slice(closeIndex + 1).trim()
      if (closeIndex !== undefined && suffix !== undefined && /^(?:as|satisfies)\b/.test(suffix)) {
        trimmed = trimmed.slice(0, closeIndex + 1).trim()
        continue
      }
    }
    break
  }
  if (!trimmed?.startsWith("{")) return
  const closeIndex = findMatching(trimmed, 0, "{", "}")
  return closeIndex === undefined ? undefined : trimmed.slice(1, closeIndex)
}

function findAngleAssertionClose(source: string): number | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue }
    if (char === "/" && next === "/") {
      const match = /[\r\n\u2028\u2029]/g
      match.lastIndex = index + 2
      const terminator = match.exec(source)
      index = terminator ? terminator.index : source.length
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (char === "<") depth++
    else if (char === ">") {
      // The `>` in an arrow return type is not the assertion delimiter.
      // This matters when that return type starts with an object literal.
      if (source[index - 1] === "=") continue
      depth--
      if (depth === 0) {
        let nextIndex = index + 1
        for (;;) {
          while (/\s/.test(source[nextIndex] || "")) nextIndex++
          if (source.startsWith("//", nextIndex)) {
            const terminator = /[\r\n\u2028\u2029]/g
            terminator.lastIndex = nextIndex + 2
            const match = terminator.exec(source)
            nextIndex = match ? match.index + 1 : source.length
            continue
          }
          if (source.startsWith("/*", nextIndex)) {
            const end = source.indexOf("*/", nextIndex + 2)
            nextIndex = end === -1 ? source.length : end + 2
            continue
          }
          break
        }
        if (source[nextIndex] === "{") return index
        depth++
      }
    }
  }
}

function stripLeadingEntryComments(entry: string) {
  return entry.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
}

function maskCommentsAndStrings(source: string) {
  let result = ""
  let quote: string | undefined
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      if (char === "\\") {
        result += "  "
        index++
      }
      else {
        result += char === "\n" || char === "\r" ? char : " "
        if (char === quote) quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      result += " "
    }
    else if (char === "/" && next !== "/" && next !== "*") {
      let previous = index - 1
      while (previous >= 0 && /\s/.test(source[previous]!)) previous--
      const preceding = source.slice(0, previous + 1)
      const followsExpressionKeyword = /(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)\s*$/.test(preceding)
      if (previous < 0 || /[=([{,:;!&|?]/.test(source[previous]!) || followsExpressionKeyword) {
        result += " "
        index++
        let inClass = false
        for (; index < source.length; index++) {
          const regexChar = source[index]!
          if (regexChar === "\\") {
            result += "  "
            index++
            continue
          }
          if (regexChar === "[") inClass = true
          else if (regexChar === "]") inClass = false
          else if (regexChar === "/" && !inClass) {
            result += " "
            while (/[A-Za-z]/.test(source[index + 1] || "")) {
              index++
              result += " "
            }
            break
          }
          result += regexChar === "\n" || regexChar === "\r" ? regexChar : " "
        }
        continue
      }
      result += char
    }
    else if (char === "/" && next === "/") {
      result += "  "
      index++
      while (index + 1 < source.length && !isLineTerminator(source[index + 1]!)) {
        result += " "
        index++
      }
      if (index + 1 < source.length && isLineTerminator(source[index + 1]!)) {
        index++
        result += source[index]!
      }
    }
    else if (char === "/" && next === "*") {
      result += "  "
      index++
      while (index + 1 < source.length) {
        index++
        const commentChar = source[index]!
        if (commentChar === "*" && source[index + 1] === "/") {
          result += "  "
          index++
          break
        }
        result += commentChar === "\n" || commentChar === "\r" ? commentChar : " "
      }
    }
    else result += char
  }
  return result
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([\p{ID_Start}$_\\][\p{ID_Continue}$\\]*)|["']([^"']+)["']|\[\s*["']([^"']+)["']\s*\])\s*(?::|$)/u.exec(stripLeadingEntryComments(entry))
  if (match?.[1]) return decodeIdentifierKey(match[1])
  if (match?.[2]) return readStaticStringLiteral(match[0].trim().slice(0, -1).trim())
  if (match?.[3]) return readStaticStringLiteral(match[0].trim().replace(/^\[\s*/, "").replace(/\s*\](?::|$)/, ""))
}

function decodeIdentifierKey(identifier: string): string | undefined {
  const decoded = identifier.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})/gi, (escape, braced, plain) => {
    const codePoint = Number.parseInt(braced ?? plain, 16)
    return Number.isInteger(codePoint) && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : escape
  })
  return /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(decoded) ? decoded : undefined
}

function readEntryValue(entry: string): string | undefined {
  const normalized = stripLeadingEntryComments(entry)
  const match = /^\s*(?:[\p{ID_Start}$_\\][\p{ID_Continue}$\\]*|["'][^"']+["']|\[\s*["'][^"']+["']\s*\])\s*:/u.exec(normalized)
  return match ? normalized.slice(match[0].length).trim() : undefined
}

function readObjectPropertyValue(body: string | undefined, property: string): string | undefined {
  if (!body) return
  for (const entry of splitTopLevel(body)) {
    if (readEntryKey(entry) !== property) continue
    // Preserve shorthand entries so callers can resolve the referenced value.
    return readEntryValue(entry) ?? property
  }
}

function readObjectKeys(body: string | undefined) {
  if (!body) return []
  return [...new Set(splitTopLevel(body).map(readEntryKey).filter((key): key is string => Boolean(key)))]
}

export interface StaticDatabaseSchema {
  /** False when the schema has entries the source cannot show, such as an imported schema or a spread. */
  complete: boolean
  tableNames: string[]
}

/** Reads the keys of a literal `schema: { ... }` without loading the Definition. */
export function readStaticDatabaseSchema(file: string): StaticDatabaseSchema {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "schema"))
  if (body === undefined) return { complete: false, tableNames: [] }
  const entries = splitTopLevel(body).map(stripLeadingEntryComments).filter(entry => entry.trim())
  return {
    complete: entries.every(entry => !entry.trimStart().startsWith("...") && readEntryKey(entry)),
    tableNames: readObjectKeys(body),
  }
}

function readConfigValue(body: string | undefined, property: string): DatabaseConfigValue | undefined {
  const expression = readObjectPropertyValue(body, property)
  if (!expression) return
  const quoted = readStaticStringLiteral(expression)
  if (typeof quoted !== "undefined") return quoted
  const declaration = readRuntimeEnvDeclaration(expression)
  if (declaration) return declaration
  const fallbackParts = splitTopLevelOperator(expression)
  if (fallbackParts.length === 1) {
    const envName = readProcessEnvName(fallbackParts[0]!)
    if (envName) return createRuntimeEnvConfigValue([envName])
  }
  if (fallbackParts.length === 2) {
    const envName = readProcessEnvName(fallbackParts[0]!)
    const fallback = fallbackParts[1]!
    if (!envName) return
    const fallbackEnvName = readProcessEnvName(fallback)
    if (fallbackEnvName) return createRuntimeEnvConfigValue([envName, fallbackEnvName])
    const staticFallback = readStaticStringLiteral(fallback)
    if (typeof staticFallback !== "undefined") return createRuntimeEnvConfigValue([envName], staticFallback)
  }
}

function splitTopLevelOperator(expression: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < expression.length - 1; i++) {
    const c = expression[i]!
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = undefined; continue }
    if (c === "\"" || c === "'") { quote = c; continue }
    if ("([{".includes(c)) { depth++; continue }
    if (")]}".includes(c)) { depth--; continue }
    if (depth === 0 && ((c === "|" && expression[i + 1] === "|") || (c === "?" && expression[i + 1] === "?"))) {
      parts.push(expression.slice(start, i).trim()); start = i + 2; i++
    }
  }
  parts.push(expression.slice(start).trim())
  return parts
}

function readRuntimeEnvDeclaration(expression: string): DatabaseConfigValue | undefined {
  const match = /^env\s*\((.*)\)$/s.exec(stripExpressionComments(expression))
  const body = objectLiteralBody(match?.[1])
  if (!body) return
  const source = readObjectPropertyValue(body, "source")?.trim()
  const sourceMatch = /^env\.source\s*\((.*)\)$/s.exec(stripExpressionComments(source || ""))
  if (!sourceMatch) return
  // `env.source` accepts options as a second argument. Static discovery only
  // needs the first argument, which may itself be an array or a literal.
  const sourceValue = splitTopLevel(sourceMatch[1]!)[0]?.trim()
  if (!sourceValue) return
  const singleName = readStaticStringLiteral(sourceValue)
  const names = typeof singleName !== "undefined"
    ? [singleName]
    : /^\[(.*)\]$/s.exec(sourceValue)?.[1]
        ? splitTopLevel(sourceValue.slice(1, -1)).filter(value => value.trim()).map(value => readStaticStringLiteral(value.trim()))
        : undefined
  if (!names?.length || names.some(name => typeof name === "undefined" || !name.trim())) return
  const defaultValue = readStaticStringLiteral(readObjectPropertyValue(body, "default")?.trim() || "")
  return createRuntimeEnvConfigValue(names as string[], defaultValue)
}

const staticStringEscapes = new Map([["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"]])

function readStaticStringLiteral(expression: string): string | undefined {
  let normalized = stripStaticTypeAssertions(stripExpressionComments(expression))
  while (normalized.endsWith("!")) normalized = normalized.slice(0, -1).trim()
  if (normalized.startsWith("<")) {
    const closeIndex = findAngleAssertionClose(normalized)
    if (closeIndex !== undefined) normalized = normalized.slice(closeIndex + 1).trim()
  }
  while (normalized.startsWith("(") && findMatching(normalized, 0, "(", ")") === normalized.length - 1) normalized = normalized.slice(1, -1).trim()
  const quote = normalized[0]
  if (normalized.length < 2 || (quote !== "'" && quote !== '"') || normalized.at(-1) !== quote) return
  let value = ""
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const char = normalized[index]!
    if (char === quote || char === "\n" || char === "\r") return
    if (char !== "\\") {
      value += char
      continue
    }
    const escaped = normalized[++index]!
    if (index >= normalized.length - 1) return
    if (escaped === "\r") {
      if (normalized[index + 1] === "\n") index += 1
      continue
    }
    if (escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") continue
    if (escaped === "u" && normalized[index + 1] === "{") {
      const match = /^\{([\da-f]+)\}/i.exec(normalized.slice(index + 1, -1))
      const codePoint = match ? Number.parseInt(match[1]!, 16) : Number.NaN
      if (!match || codePoint > 0x10FFFF) return
      value += String.fromCodePoint(codePoint)
      index += match[0].length
      continue
    }
    if (escaped === "u" || escaped === "x") {
      const length = escaped === "u" ? 4 : 2
      const hex = normalized.slice(index + 1, index + 1 + length)
      if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) return
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += length
      continue
    }
    if (/\d/.test(escaped) && (escaped !== "0" || /\d/.test(normalized[index + 1] || ""))) return
    value += escaped === "0" ? "\0" : staticStringEscapes.get(escaped) ?? escaped
  }
  return value
}

function readStaticStringReference(expression: string | undefined, source: string, seen = new Set<string>()): string | undefined {
  if (!expression) return
  const direct = readStaticStringLiteral(expression)
  if (direct !== undefined) return direct
  const identifier = expression.trim()
  if (!/^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(identifier) || seen.has(identifier)) return
  seen.add(identifier)
  return readStaticStringReference(readOpaqueDeclarationExpression(identifier, source), source, seen)
}

/** Remove comments while preserving quoted literal contents. */
function stripExpressionComments(expression: string): string {
  let result = ""
  let quote: string | undefined
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]!
    const next = expression[index + 1]
    if (quote) {
      result += char
      if (char === "\\" && next !== undefined) result += expression[++index]!
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      result += char
    }
    else if (char === "/" && next === "/") {
      index += 1
      while (index + 1 < expression.length && !isLineTerminator(expression[index + 1]!)) index++
      result += " "
    }
    else if (char === "/" && next === "*") {
      index += 2
      while (index < expression.length && !(expression[index] === "*" && expression[index + 1] === "/")) index++
      if (index < expression.length) index++
      result += " "
    }
    else result += char
  }
  return result.trim()
}

function stripStaticTypeAssertions(expression: string): string {
  let value = expression.trim()
  for (;;) {
    let depth = 0
    let quote: string | undefined
    let assertionIndex = -1
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!
      if (quote) {
        if (char === "\\") index++
        else if (char === quote) quote = undefined
        continue
      }
      if (char === "'" || char === '"' || char === "`") { quote = char; continue }
      if ("([{<".includes(char)) { depth++; continue }
      if (")]}>".includes(char)) { depth--; continue }
      if (depth === 0 && (value.startsWith("as", index) || value.startsWith("satisfies", index))) {
        const word = value.startsWith("as", index) ? "as" : "satisfies"
        if (!/[\w$]/.test(value[index - 1] || "") && !/[\w$]/.test(value[index + word.length] || "")) assertionIndex = index
      }
    }
    if (assertionIndex >= 0) { value = value.slice(0, assertionIndex).trim(); continue }
    if (value.startsWith("(") && findMatching(value, 0, "(", ")") === value.length - 1) {
      value = value.slice(1, -1).trim(); continue
    }
    return value
  }
}

function readProcessEnvName(expression: string) {
  const normalized = stripStaticTypeAssertions(stripExpressionComments(expression))
  return /^process\.env\.([\p{ID_Start}$_][\p{ID_Continue}$]*)$/u.exec(normalized)?.[1]
    ?? (() => {
      const match = /^process\.env\[([\s\S]+)\]$/.exec(normalized)
      const value = match ? readStaticStringLiteral(match[1]!.trim()) : undefined
      return typeof value === "string" && identifierPattern.test(value) ? value : undefined
    })()
}

function readStringValue(body: string | undefined, property: string): string | undefined {
  const value = readConfigValue(body, property)
  const resolved = resolveConfigValue(value)
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

type DefinitionCloudflareResource = CloudflareD1Projection["resource"]

function readDefinitionCloudflareResource(expression: string | undefined): DefinitionCloudflareResource {
  if (expression?.trim() === "undefined") return "inherited"
  const body = objectLiteralBody(expression)
  if (body === undefined) return "opaque"
  let resource: DefinitionCloudflareResource = "inherited"
  for (const property of splitTopLevel(body)) {
    const normalized = stripLeadingEntryComments(property)
    if (!normalized.trim()) continue
    const key = readEntryKey(normalized)
    if (normalized.trimStart().startsWith("...") || !key) return "opaque"
    if (key !== "databaseId" && key !== "databaseName") continue
    if (readEntryValue(normalized)?.trim() === "undefined") continue
    if (readConfigValue(body, key) === undefined) return "opaque"
    resource = "configured"
  }
  return resource
}

function readOpaqueDeclarationExpression(identifier: string, source: string): string | undefined {
  const masked = maskCommentsAndStrings(source)
  // At a top-level newline, any export form starts a new statement. This
  // includes export-only lists/star exports and exported async functions,
  // which do not have a declaration keyword immediately after `export`.
  const topLevelStatementStart = /^\s*(?:export\b|async\s+function\b|abstract\s+class\b|(?:const|let|var|function|class|interface|type|enum|namespace|declare|import)\b)/
  const declarations = [...masked.matchAll(new RegExp(`(?:^|[;\\n\\r])\\s*(?:export\\s+)?(?:const|let|var)\\s+${identifierCapturePattern}\\s*(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*`, "gu"))]
  for (let declarationIndex = 0; declarationIndex < declarations.length; declarationIndex++) {
    const declaration = declarations[declarationIndex]!
    let depth = 0
    for (const char of masked.slice(0, declaration.index)) {
      if (char === "{") depth++
      else if (char === "}") depth--
    }
    if (depth !== 0) continue
    const valueStart = declaration.index + declaration[0].length
    const nextDeclaration = declarations.slice(declarationIndex + 1).find((candidate) => {
      let candidateDepth = 0
      for (const char of masked.slice(0, candidate.index)) {
        if (char === "{") candidateDepth++
        else if (char === "}") candidateDepth--
      }
      return candidateDepth === 0
    })
    const limit = nextDeclaration?.index ?? masked.length
    const remainder = masked.slice(valueStart, limit)
    if (declaration[1] === identifier) {
      let expressionEnd = remainder.length
      let nested = 0
      for (let index = 0; index < remainder.length; index++) {
        const char = remainder[index]!
        if (char === "{" || char === "[" || char === "(") nested++
        else if (char === "}" || char === "]" || char === ")") nested = Math.max(0, nested - 1)
        else if (char === ";" && nested === 0) { expressionEnd = index; break }
        else if (nested === 0 && (char === "\n" || char === "\r")) {
          const following = remainder.slice(index + 1)
          if (topLevelStatementStart.test(following)) {
            expressionEnd = index
            break
          }
        }
      }
      return stripLeadingEntryComments(source.slice(valueStart, valueStart + expressionEnd))
    }
    const parts = splitTopLevel(remainder)
    let partOffset = 0
    for (const part of parts) {
      const name = new RegExp(`^\\s*${identifierCapturePattern}\\s*=`, "u").exec(part)?.[1]
      if (name !== identifier) {
        partOffset += part.length + 1
        continue
      }
      const equals = part.indexOf("=")
      const expressionStart = valueStart + partOffset + equals + 1
      const expression = masked.slice(expressionStart, valueStart + partOffset + part.length)
      let expressionEnd = expression.length
      let nested = 0
      for (let index = 0; index < expression.length; index++) {
        const char = expression[index]!
        if (char === "{" || char === "[" || char === "(") nested++
        else if (char === "}" || char === "]" || char === ")") nested = Math.max(0, nested - 1)
        else if (char === ";" && nested === 0) { expressionEnd = index; break }
        else if (nested === 0 && (char === "\n" || char === "\r")) {
          const following = remainder.slice(index + 1)
          if (topLevelStatementStart.test(following)) {
            expressionEnd = index
            break
          }
        }
      }
      return stripLeadingEntryComments(source.slice(expressionStart, expressionStart + expressionEnd))
    }
  }
  return undefined
}

function readOpaqueResourceOwnership(expression: string | undefined, source: string, seen = new Set<string>()): boolean | undefined {
  const trimmed = expression?.trim()
  if (!trimmed) return undefined
  const body = objectLiteralBody(trimmed)
  if (body !== undefined) {
    const id = readOpaquePropertyExpression(trimmed, "databaseId", source, seen)
    const name = readOpaquePropertyExpression(trimmed, "databaseName", source, seen)
    const hasId = opaqueObjectContainsKey(trimmed, source, "databaseId")
    const hasName = opaqueObjectContainsKey(trimmed, source, "databaseName")
    // An unresolved spread may provide either resource key at runtime. Keep
    // ownership unknown until every spread path is proven key-free.
    if (hasId === undefined || hasName === undefined) return undefined
    if (!hasId && !hasName) return false
    const resolving = new Set<string>()
    const resolve = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined
      const normalized = value.trim()
      if (normalized === "undefined") return "undefined"
      if (!identifierPattern.test(normalized)) return normalized
      if (resolving.has(normalized)) return undefined
      resolving.add(normalized)
      const declaration = readOpaqueDeclarationExpression(normalized, source)
      const result = declaration === undefined ? undefined : resolve(declaration)
      resolving.delete(normalized)
      return result
    }
    const resolvedId = resolve(id)
    const resolvedName = resolve(name)
    if ((hasId && resolvedId === undefined) || (hasName && resolvedName === undefined)) return undefined
    return (resolvedId !== undefined && resolvedId !== "undefined") || (resolvedName !== undefined && resolvedName !== "undefined")
  }
  const identifier = identifierPattern.test(trimmed) ? trimmed : undefined
  if (!identifier || seen.has(identifier)) return undefined
  seen.add(identifier)
  return readOpaqueResourceOwnership(readOpaqueDeclarationExpression(identifier, source), source, seen)
}

function readOpaquePropertyExpression(expression: string, key: string, source: string, seen = new Set<string>()): string | undefined {
  const body = objectLiteralBody(expression)
  if (body === undefined) {
    const identifier = expression.trim()
    if (!identifierPattern.test(identifier) || seen.has(identifier)) return undefined
    const next = new Set(seen)
    next.add(identifier)
    return readOpaquePropertyExpression(readOpaqueDeclarationExpression(identifier, source) ?? "", key, source, next)
  }
  let value: string | undefined
  let found = false
  let unresolvedOverride = false
  for (const entry of splitTopLevel(body)) {
    const normalized = stripLeadingEntryComments(entry).trim()
    if (!normalized) continue
    if (normalized.startsWith("...")) {
      const spreadExpression = normalized.slice(3)
      const hasKey = opaqueObjectContainsKey(spreadExpression, source, key, new Set(seen))
      if (hasKey === undefined) {
        // Keep scanning: a later explicit property overrides an uncertain
        // spread, while an uncertain spread after the final known property
        // makes the effective value unknown.
        unresolvedOverride = true
        continue
      }
      if (hasKey) {
        const spread = readOpaquePropertyExpression(spreadExpression, key, source, new Set(seen))
        if (spread === undefined) {
          unresolvedOverride = true
          continue
        }
        value = spread
        found = true
        unresolvedOverride = false
      }
      continue
    }
    if (readEntryKey(normalized) !== key) continue
    found = true
    // A shorthand property has the identifier itself as its value. Preserve
    // that reference so the declaration resolver can evaluate it below.
    value = readEntryValue(normalized)?.trim() ?? readEntryKey(normalized)
    unresolvedOverride = false
  }
  return found && !unresolvedOverride ? value : undefined
}

function opaqueObjectContainsKey(expression: string, source: string, key: string, seen = new Set<string>()): boolean | undefined {
  const trimmed = expression.trim()
  const body = objectLiteralBody(trimmed)
  if (body !== undefined) {
    let unresolved = false
    let found = false
    for (const property of splitTopLevel(body)) {
      const normalized = stripLeadingEntryComments(property).trim()
      if (!normalized) continue
      if (readEntryKey(normalized) === key) {
        found = true
        continue
      }
      if (normalized.startsWith("...")) {
        const result = opaqueObjectContainsKey(normalized.slice(3), source, key, new Set(seen))
        if (result === true) found = true
        if (result === undefined) unresolved = true
      }
    }
    return unresolved ? undefined : found
  }
  const identifier = identifierPattern.test(trimmed) ? trimmed : undefined
  if (!identifier || seen.has(identifier)) return undefined
  const next = new Set(seen)
  next.add(identifier)
  const declaration = readOpaqueDeclarationExpression(identifier, source)
  return declaration === undefined ? undefined : opaqueObjectContainsKey(declaration, source, key, next)
}

function readOpaqueHttpOnly(expression: string | undefined, source: string, seen = new Set<string>()): boolean | undefined {
  const trimmed = expression?.trim()
  if (!trimmed) return undefined
  const body = objectLiteralBody(trimmed)
  if (body !== undefined) {
    let httpOnly: boolean | undefined = false
    for (const property of splitTopLevel(body)) {
      const normalized = stripLeadingEntryComments(property).trim()
      if (!normalized) continue
      const key = readEntryKey(normalized)
      if (key === "http") {
        const rawValue = readEntryValue(normalized)?.trim() ?? key
        const value = rawValue === key
          ? readOpaqueDeclarationExpression(key, source)?.trim()
          : rawValue
        if (value === "true" || objectLiteralBody(value) !== undefined) httpOnly = true
        else if (value === "false") httpOnly = false
        else httpOnly = undefined
        continue
      }
      if (normalized.startsWith("...")) {
        const spreadExpression = normalized.slice(3)
        // Each sibling spread is an independent object traversal. Reusing the
        // visited set can turn a previously proven HTTP-only value into an
        // unresolved result when both paths reference the same nested object.
        const spread = readOpaqueHttpOnly(spreadExpression, source, new Set(seen))
        const hasHttp = opaqueObjectContainsKey(spreadExpression, source, "http")
        if (hasHttp === undefined) httpOnly = undefined
        else if (hasHttp) httpOnly = spread
      }
    }
    return httpOnly
  }
  const identifier = identifierPattern.test(trimmed) ? trimmed : undefined
  if (!identifier || seen.has(identifier)) return undefined
  seen.add(identifier)
  return readOpaqueHttpOnly(readOpaqueDeclarationExpression(identifier, source), source, seen)
}

function readDefinitionCloudflareConfig(file: string): { resource: DefinitionCloudflareResource, configured: boolean, ownsOpaqueResource?: boolean, opaqueHttpOnly?: boolean, opaqueBinding?: string, value?: CloudflareD1BindingConfig } {
  const source = readFileSync(file, "utf8")
  const definitionBody = readDefinitionObjectBody(file)
  const definitionEntries = definitionBody === undefined
    ? []
    : splitTopLevel(definitionBody).map(stripLeadingEntryComments)
  const cloudflareEntries = definitionEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => readEntryKey(entry) === "cloudflare" || entry.trim() === "cloudflare")
  const cloudflareEntry = cloudflareEntries.at(-1)
  const trailingDefinitionSpread = cloudflareEntry !== undefined && definitionEntries
    .slice(cloudflareEntry.index + 1)
    .some(entry => entry.trimStart().startsWith("..."))
  // A later definition-level spread can replace the whole Cloudflare value.
  // Keep the effective expression unresolved rather than inspecting the
  // earlier property and reporting a binding the runtime may not emit.
  const expression = cloudflareEntry !== undefined && !trailingDefinitionSpread
    ? readEntryValue(cloudflareEntry.entry) ?? (cloudflareEntry.entry.trim() === "cloudflare" ? "cloudflare" : undefined)
    : undefined
  let resource: DefinitionCloudflareResource = definitionBody === undefined ? "opaque" : "inherited"
  for (const entry of definitionEntries) {
    if (!entry.trim()) continue
    const key = readEntryKey(entry)
    if (entry.trimStart().startsWith("...") || !key) {
      resource = "opaque"
    }
    else if (key === "cloudflare") {
      resource = readDefinitionCloudflareResource(readEntryValue(entry))
    }
  }
  const body = objectLiteralBody(expression)
  if (resource === "opaque") {
    const ownsOpaqueResource = readOpaqueResourceOwnership(expression, source)
    const opaqueHttpOnly = readOpaqueHttpOnly(expression, source)
    const resolvedExpression = body === undefined && expression
      ? readOpaqueDeclarationExpression(expression.trim(), source)
      : expression
    const rawBinding = resolvedExpression ? readOpaquePropertyExpression(resolvedExpression, "binding", source)?.trim() : undefined
    const bindingExpression = rawBinding && identifierPattern.test(rawBinding)
      ? readOpaqueDeclarationExpression(rawBinding, source)?.trim() ?? rawBinding
      : rawBinding
    const binding = readStaticStringReference(bindingExpression, source)
    if (cloudflareEntries.length && expression?.trim() !== "undefined") {
      return {
        resource,
        configured: true,
        ownsOpaqueResource,
        opaqueHttpOnly,
        ...(binding ? { opaqueBinding: binding } : {}),
        value: {},
      }
    }
    return { resource, configured: false, ownsOpaqueResource, opaqueHttpOnly }
  }
  if (body === undefined) return { resource, configured: cloudflareEntries.length > 0 && expression?.trim() !== "undefined", ownsOpaqueResource: false }
  const resolveProperty = (property: string) => {
    const raw = readObjectPropertyValue(body, property)?.trim()
    if (!raw || raw === "undefined") return raw
    if (!identifierPattern.test(raw)) return raw
    return readOpaqueDeclarationExpression(raw, source)?.trim() ?? raw
  }
  const httpExpression = resolveProperty("http")
  const httpBody = objectLiteralBody(httpExpression)
  const http = httpExpression === "true"
    ? true
    : httpBody
      ? {
          authToken: readConfigValue(httpBody, "authToken"),
          url: readConfigValue(httpBody, "url"),
        } satisfies CloudflareD1HttpConfig
      : undefined
  const value: CloudflareD1BindingConfig = {
    binding: readStringValue(`binding: ${resolveProperty("binding")}`, "binding"),
    databaseId: readConfigValue(`databaseId: ${resolveProperty("databaseId")}`, "databaseId"),
    databaseName: readConfigValue(`databaseName: ${resolveProperty("databaseName")}`, "databaseName"),
    migrationsTable: readStringValue(`migrationsTable: ${resolveProperty("migrationsTable")}`, "migrationsTable"),
    previewDatabaseId: readConfigValue(`previewDatabaseId: ${resolveProperty("previewDatabaseId")}`, "previewDatabaseId"),
  }
  if (http && (http === true || http.authToken || http.url)) value.http = http
  return {
    resource,
    configured: cloudflareEntries.length > 0 && expression?.trim() !== "undefined",
    ownsOpaqueResource: false,
    ...(Object.values(value).some(item => typeof item !== "undefined") ? { value } : {}),
  }
}

// Partial scanner results cannot prove HTTP stays enabled after runtime spreads.
export function isStaticD1HttpDefinition(file: string) {
  if (!existsSync(file)) return false
  const definitionBody = readDefinitionObjectBody(file)
  if (definitionBody === undefined) return false
  const definitionEntries = splitTopLevel(definitionBody).filter(entry => entry.trim())
  if (definitionEntries.some(entry => !readEntryKey(entry))) return false
  const cloudflareEntries = definitionEntries.filter(entry => readEntryKey(entry) === "cloudflare")
  if (cloudflareEntries.length !== 1) return false
  const expression = readEntryValue(cloudflareEntries[0]!)?.trim()
  const body = objectLiteralBody(expression)
  if (body === undefined || expression !== `{${body}}`) return false
  const entries = splitTopLevel(body).filter(entry => entry.trim())
  if (entries.some(entry => !readEntryKey(entry))) return false
  const httpEntries = entries.filter(entry => readEntryKey(entry) === "http")
  if (httpEntries.length !== 1) return false
  const http = readEntryValue(httpEntries[0]!)?.trim()
  const httpBody = objectLiteralBody(http)
  return http === "true" || (httpBody !== undefined && http === `{${httpBody}}`)
}

function readDefinitionConnectionConfig(file: string) {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "connection"))
  if (!body) return
  const value = {
    authToken: readConfigValue(body, "authToken"),
    url: readConfigValue(body, "url"),
  }
  return Object.values(value).some(item => typeof item !== "undefined") ? value : undefined
}

/** Reads the static `dialect` of a Database Definition. A Definition without one uses SQLite. */
export function readDatabaseDefinitionDialect(file: string): DatabaseDialect {
  const expression = readObjectPropertyValue(readDefinitionObjectBody(file), "dialect")?.trim()
  if (expression === undefined) return "sqlite"
  const dialect = readStaticStringLiteral(expression)
  if (dialect === "sqlite" || dialect === "postgresql") return dialect
  throw databaseErrorDiagnostics.DATABASE_INVALID_DIALECT({ file })
}

function readDefinitionHyperdriveConfig(file: string, name: string): ResolvedCloudflareHyperdriveConfig {
  const body = objectLiteralBody(readObjectPropertyValue(readDefinitionObjectBody(file), "cloudflare"))
  const config: ResolvedCloudflareHyperdriveConfig = { binding: resolveCloudflareHyperdriveBindingName(name, readStringValue(body, "binding")) }
  const hyperdriveId = readConfigValue(body, "hyperdriveId")
  if (hyperdriveId !== undefined) config.hyperdriveId = hyperdriveId
  return config
}

type FoundDatabaseDefinition = Omit<DiscoveredDatabaseDefinition, "schemaSources">

function createDatabaseDefinition(source: string, file: string, name: string, mode: "default" | "named"): FoundDatabaseDefinition {
  const configuredName = readStringValue(readDefinitionObjectBody(file), "name")?.trim() || "default"
  if (configuredName !== name) {
    throw databaseErrorDiagnostics.DATABASE_NAME_MISMATCH({ file, name })
  }
  return {
    handler: file,
    mode,
    name,
    source,
    tableNames: readStaticDatabaseSchema(file).tableNames,
  }
}

function discoverServerDatabases(serverDir: string) {
  return discoverDefinitions<FoundDatabaseDefinition>("database", [
    createDirectoryDefinitionSource("server-database-default", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        return dirname(file).replace(/\\/g, "/") === directory.replace(/\\/g, "/") ? "default" : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("server-database-default", file, name, "default"),
    }),
    createDirectoryDefinitionSource("server-databases-named", [serverDir], "databases", {
      normalizeName(directory, file) {
        if (!configFilePattern.test(file.split(/[\\/]/).pop() || "")) return
        const name = relative(directory, dirname(file)).replace(/\\/g, "/")
        return name && name !== "." ? name : undefined
      },
      createDefinition: ({ file, name }) => createDatabaseDefinition("server-databases-named", file, name, "named"),
    }),
  ])
}

function discoverViteDatabases(rootDir: string) {
  const defaultFile = resolve(rootDir, "src", "database.ts")
  const defaultDefinitions = existsSync(defaultFile)
    ? [createDatabaseDefinition("vite-database-default", defaultFile, "default", "default")]
    : []
  const suffixDefinitions = discoverDefinitions<FoundDatabaseDefinition>("database", [
    createSuffixDefinitionSource("vite-database-suffix", [rootDir], viteDatabaseSuffixPattern, (root, file) => {
      const name = normalizeSuffixDefinitionName(root, file, viteDatabaseSuffixPattern, { stripPrefix: "src/" })
      return name === "database" ? undefined : name
    }, {
      createDefinition: ({ file, name }) => createDatabaseDefinition("vite-database-suffix", file, name, "named"),
    }),
  ])
  return [...defaultDefinitions, ...suffixDefinitions]
}

const schemaOnlyDefinitionKeys = new Set(["name", "schema"])

/** Lists the database options that a Definition sets, or returns `undefined` when ViteHub cannot read them. */
function readDefinitionOptionKeys(file: string): Set<string> | undefined {
  const body = readDefinitionObjectBody(file)
  if (body === undefined) return
  const keys = new Set<string>()
  for (const entry of splitTopLevel(body)) {
    const normalized = stripLeadingEntryComments(entry)
    if (!normalized.trim()) continue
    const key = readEntryKey(normalized)
    if (normalized.trimStart().startsWith("...") || !key) return
    if (!schemaOnlyDefinitionKeys.has(key)) keys.add(key)
  }
  return keys
}

/** Reports whether a Definition can set database options. Opaque Definitions count because ViteHub cannot read them. */
function configuresDatabase(file: string) {
  const keys = readDefinitionOptionKeys(file)
  return keys === undefined || keys.size > 0
}

function listDefinitionFiles(definitions: Array<{ handler: string }>) {
  return definitions.map(definition => `  - ${definition.handler}`)
}

/**
 * Merges the Definitions of one database. Layer 0 is the application. Higher layers are Nuxt layers in priority order.
 * Options come from the application when it sets them, and otherwise from the one layer that sets them.
 * An application table replaces a layer table with the same key. Two layers cannot declare the same table.
 */
function mergeLayerDefinitions(name: string, entries: Array<{ definition: FoundDatabaseDefinition, layer: number }>): DiscoveredDatabaseDefinition {
  const ordered = [...entries].sort((left, right) => left.layer - right.layer)
  const sameLayer = ordered.find((entry, index) => index > 0 && entry.layer === ordered[index - 1]!.layer)
  if (sameLayer) {
    const duplicates = ordered.filter(entry => entry.layer === sameLayer.layer).map(entry => entry.definition)
    throw databaseErrorDiagnostics.DATABASE_DUPLICATE_DEFINITION({ database: name, files: duplicates.map(definition => definition.handler) })
  }

  const app = ordered[0]!.layer === 0 ? ordered[0]!.definition : undefined
  const appConfigures = app !== undefined && configuresDatabase(app.handler)
  const layers = ordered.filter(entry => entry.layer > 0).map(entry => entry.definition)
  const configuringLayers = layers.filter(definition => configuresDatabase(definition.handler))
  // The application Definition supplies every option when it sets one, so a layer option that it does not repeat would be lost.
  if (app && appConfigures) {
    const appOptions = readDefinitionOptionKeys(app.handler)
    for (const layer of configuringLayers) {
      const layerOptions = readDefinitionOptionKeys(layer.handler)
      if (!appOptions || !layerOptions) {
        throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: [app.handler, layer.handler], reason: "unreadable" })
      }
      const missing = [...layerOptions].filter(key => !appOptions.has(key))
      if (!missing.length) continue
      const options = missing.map(key => `\`${key}\``).join(", ")
      throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: [app.handler, layer.handler], options, reason: "missing" })
    }
  }
  if (!appConfigures && configuringLayers.length > 1) {
    throw databaseErrorDiagnostics.DATABASE_LAYER_OPTIONS_CONFLICT({ database: name, files: configuringLayers.map(definition => definition.handler), reason: "layers" })
  }

  const appTables = new Set(app?.tableNames)
  const tableOwners = new Map<string, FoundDatabaseDefinition>()
  for (const definition of layers) {
    for (const tableName of definition.tableNames ?? []) {
      const owner = tableOwners.get(tableName)
      if (owner && !appTables.has(tableName)) {
        throw databaseErrorDiagnostics.DATABASE_LAYER_TABLE_CONFLICT({ database: name, files: [owner.handler, definition.handler], table: tableName })
      }
      tableOwners.set(tableName, definition)
    }
  }

  const owner = (appConfigures ? app : configuringLayers[0]) ?? app ?? layers[0]!
  // Later sources take precedence, so the application comes last.
  const schemaSources = [...ordered].reverse().map(({ definition }) => ({ handler: definition.handler, tableNames: (definition.tableNames ?? []) }))
  return {
    ...owner,
    schemaSources,
    tableNames: [...new Set(ordered.flatMap(({ definition }) => (definition.tableNames ?? [])))],
  }
}

const implicitDefaultSource = "implicit-default"

/**
 * The empty default Database of an app that enables `database` without a Database Definition, for example for the
 * tables of Connections. It is `defineDatabase({ schema: {} })` from a module that this package ships.
 */
function implicitDefaultDatabase(): DiscoveredDatabaseDefinition {
  const handler = resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/default-database")
  return { handler, mode: "default", name: "default", schemaSources: [{ handler, tableNames: [] }], source: implicitDefaultSource, tableNames: [] }
}

/** Reports whether a discovered Definition is the implicit default Database, which the app does not own. */
export function isImplicitDefaultDatabase(definition: Pick<DiscoveredDatabaseDefinition, "source">): boolean {
  return definition.source === implicitDefaultSource
}

export interface DatabaseDiscoveryOptions {
  /**
   * Without a Database Definition, return the implicit default Database. The Vite plugin sets it: an enabled
   * database always has a default Database.
   */
  implicitDefault?: boolean
  serverDirs?: string[]
}

export function discoverDatabaseDefinitions(rootDir: string, options: DatabaseDiscoveryOptions = {}): DiscoveredDatabaseDefinition[] {
  const definitions = discoverAppDatabaseDefinitions(rootDir, options)
  return definitions.length || !options.implicitDefault ? definitions : [implicitDefaultDatabase()]
}

function discoverAppDatabaseDefinitions(rootDir: string, options: DatabaseDiscoveryOptions): DiscoveredDatabaseDefinition[] {
  const serverDirs = options.serverDirs ?? [resolve(rootDir, "server")]
  const found = [
    ...serverDirs.flatMap((serverDir, layer) => discoverServerDatabases(serverDir).map(definition => ({ definition, layer }))),
    ...discoverViteDatabases(rootDir).map(definition => ({ definition, layer: 0 })),
  ].filter((entry, index, all) => all.findIndex(item => item.definition.handler === entry.definition.handler) === index)
  const defaults = found.filter(entry => entry.definition.mode === "default")
  const named = found.filter(entry => entry.definition.mode === "named")
  if (defaults.length && named.length) {
    throw databaseErrorDiagnostics.DATABASE_MIXED_DEFINITIONS({ files: found.map(entry => entry.definition.handler) })
  }
  const byName = new Map<string, typeof found>()
  for (const entry of found) {
    const entries = byName.get(entry.definition.name) ?? []
    entries.push(entry)
    byName.set(entry.definition.name, entries)
  }
  return [...byName].map(([name, entries]) => mergeLayerDefinitions(name, entries))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function isWithinDirectory(directory: string, file: string) {
  const path = relative(directory, file)
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path)
}

/**
 * Keeps migrations in the application, also when a Nuxt layer owns the database options. The implicit default
 * Database uses the directory that `server/databases/config.ts` would use.
 */
function getDefaultMigrationsDir(rootDir: string, definition: DiscoveredDatabaseDefinition, serverDirs: string[] | undefined) {
  const [appServerDir, ...layerServerDirs] = serverDirs ?? []
  if (isImplicitDefaultDatabase(definition)) return relative(rootDir, resolve(appServerDir ?? resolve(rootDir, "server"), "databases", "migrations"))
  const ownedByLayer = appServerDir !== undefined && !isWithinDirectory(appServerDir, definition.handler)
    && layerServerDirs.some(directory => isWithinDirectory(directory, definition.handler))
  const directory = ownedByLayer
    ? resolve(appServerDir, "databases", ...(definition.mode === "named" ? [definition.name] : []))
    : dirname(definition.handler)
  return relative(rootDir, resolve(directory, "migrations"))
}

function normalizeCloudflareConfig(
  value: CloudflareD1BindingConfig | undefined,
  name: string,
  migrationsDir: string,
): ResolvedCloudflareD1BindingConfig | undefined {
  if (!value) return
  return {
    binding: resolveCloudflareD1BindingName(name, value.binding),
    ...(typeof value.databaseId !== "undefined" ? { databaseId: value.databaseId } : {}),
    ...(typeof value.http !== "undefined" ? { http: value.http } : {}),
    ...(typeof value.previewDatabaseId !== "undefined" ? { previewDatabaseId: value.previewDatabaseId } : {}),
    ...(typeof value.databaseName !== "undefined" ? { databaseName: value.databaseName } : {}),
    migrationsDir,
    ...(typeof value.migrationsTable === "string" && value.migrationsTable.trim() ? { migrationsTable: value.migrationsTable.trim() } : {}),
  }
}

function getDefaultConnection(name: string) {
  return {
    authToken: undefined,
    url: name === "default" ? "file:.vitehub/data/database/sqlite.db" : `file:.vitehub/data/database/${name}.sqlite.db`,
  }
}

function hasConnectionValue(value: DatabaseConfigValue | undefined) {
  return typeof value === "string" ? Boolean(value.trim()) : typeof value !== "undefined"
}

function selectConnectionValue(value: DatabaseConfigValue | undefined, fallback: DatabaseConfigValue | undefined) {
  const resolved = resolveConfigValue(value)
  if (typeof resolved === "string" && resolved.trim()) return value
  return typeof value === "object" && typeof fallback !== "undefined" ? value : fallback
}

function resolveDefinitionConnection(file: string, name: string, fallback?: DatabaseConnectionConfig) {
  const definition = readDefinitionConnectionConfig(file)
  const url = selectConnectionValue(definition?.url, fallback?.url)
  if (!hasConnectionValue(url)) return getDefaultConnection(name)
  return {
    authToken: hasConnectionValue(definition?.authToken) ? definition?.authToken : fallback?.authToken,
    url,
  }
}

function createGeneratedSchemaFile(rootDir: string, name: string) {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: `schema/${sanitizeDefinitionFilename(name)}.ts`,
    productName: "database",
  })
}

function createGeneratedDrizzleConfigFile(rootDir: string, name: string) {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: `drizzle/${sanitizeDefinitionFilename(name)}.config.ts`,
    productName: "database",
  })
}

export function resolveDBViteConfig(
  options?: DBModulePublicOptions,
  rootDir = process.cwd(),
  context: {
    /** Tables that Vite plugins contribute. See `collectDatabaseContributions()`. */
    contributions?: readonly CollectedDatabaseContribution[]
    /** Without a Database Definition, resolve the implicit default Database. See `discoverDatabaseDefinitions()`. */
    implicitDefault?: boolean
    provisionRoot?: string
    serverDirs?: string[]
  } = {},
): ResolvedDBViteConfig | undefined {
  if (options === false) return

  const definitions = discoverDatabaseDefinitions(rootDir, context)
  if (!definitions.length) {
    // Contributed tables need a Database, so this fails when a plugin contributes tables.
    resolveDatabaseContributionTargets([], context.contributions ?? [])
    return
  }

  const databases: Record<string, ResolvedDrizzleDatabaseConfig> = Object.create(null)
  const cloudflareProjections: Record<string, CloudflareD1Projection> = Object.create(null)
  const generatedDrizzleConfigFilesByDatabase: Record<string, string> = Object.create(null)
  const generatedSchemaFilesByDatabase: Record<string, string> = Object.create(null)
  const provisionState = readProvisionStateSync(context.provisionRoot ?? rootDir)
  for (const definition of definitions) {
    const migrationsDir = getDefaultMigrationsDir(rootDir, definition, context.serverDirs)
    const generatedSchemaFile = createGeneratedSchemaFile(rootDir, definition.name)
    generatedDrizzleConfigFilesByDatabase[definition.name] = createGeneratedDrizzleConfigFile(rootDir, definition.name)
    generatedSchemaFilesByDatabase[definition.name] = generatedSchemaFile
    // Postgres Definitions own their connection. SQLite, libSQL, and D1 integration defaults do not apply.
    if (readDatabaseDefinitionDialect(definition.handler) === "postgresql") {
      const url = readDefinitionConnectionConfig(definition.handler)?.url
      databases[definition.name] = {
        connection: url === undefined ? {} : { url },
        dialect: "postgresql",
        drizzle: {},
        generatedSchemaFile,
        hyperdrive: readDefinitionHyperdriveConfig(definition.handler, definition.name),
        migrationsDir,
        mode: definition.mode,
        name: definition.name,
        orm: "drizzle",
      }
      continue
    }
    const definitionCloudflare = readDefinitionCloudflareConfig(definition.handler)
    const projection: CloudflareD1Projection = { resource: definitionCloudflare.resource }
    cloudflareProjections[definition.name] = projection
    const cloudflare = normalizeCloudflareConfig(mergeCloudflareConfig(cloudflareOptions(options), definitionCloudflare.value), definition.name, migrationsDir)
    if (cloudflare) {
      if (definitionCloudflare.resource !== "opaque" && definition.name !== "default" && !definitionCloudflare.value?.binding) {
        cloudflare.binding = resolveCloudflareD1BindingName(definition.name, undefined)
      }
      projection.provisionedId = provisionState.cloudflare?.d1?.[definition.name]
      if (definitionCloudflare.resource !== "opaque") {
        cloudflare.databaseId = withConfigValueFallback(cloudflare.databaseId, projection.provisionedId)
        const native = resolveCloudflareD1Binding({ ...cloudflare, database: definition.name }, { provisionState })
        if (native.d1Database) projection.binding = native.bindingName
      }
    }
    databases[definition.name] = {
      cloudflare,
      connection: resolveDefinitionConnection(definition.handler, definition.name, options?.connection),
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile,
      migrationsDir,
      mode: definition.mode,
      name: definition.name,
      orm: "drizzle",
    }
  }

  const cloudflareBindings = new Map<string, string>()
  for (const definition of definitions) {
    // PostgreSQL Definitions never emit native D1 bindings. Their Cloudflare
    // field is reserved for Hyperdrive settings, so exclude them from this
    // SQLite/D1 collision check.
    if (readDatabaseDefinitionDialect(definition.handler) === "postgresql") continue
    const definitionCloudflare = readDefinitionCloudflareConfig(definition.handler)
    // Opaque definitions that prove resource ownership or HTTP-only behavior
    // do not emit native D1 bindings and must stay out of this check.
    if (definitionCloudflare.resource === "opaque" && (definitionCloudflare.ownsOpaqueResource === true || definitionCloudflare.opaqueHttpOnly === true)) continue
    const effectiveCloudflare = databases[definition.name]?.cloudflare
    if (effectiveCloudflare?.http) continue
    const canSynthesizeOpaqueBinding = definitionCloudflare.resource !== "opaque"
      || (definitionCloudflare.ownsOpaqueResource === false && definitionCloudflare.opaqueHttpOnly === false)
    const binding = (definitionCloudflare.resource !== "opaque" ? effectiveCloudflare?.binding : undefined)
      ?? definitionCloudflare.opaqueBinding
      ?? (canSynthesizeOpaqueBinding
        ? (definitionCloudflare.configured ? resolveCloudflareD1BindingName(definition.name, undefined) : undefined)
        : undefined)
    if (!binding) continue
    const previousName = cloudflareBindings.get(binding)
    if (previousName && previousName !== definition.name) {
      throw databaseErrorDiagnostics.DATABASE_C0008({
        message: `[vitehub] Database definitions "${previousName}" and "${definition.name}" resolve to the same Cloudflare D1 binding "${binding}". Set a unique \`cloudflare.binding\` for each database.`,
      })
    }
    cloudflareBindings.set(binding, definition.name)
  }

  const tableContributionsByDatabase = resolveDatabaseContributionTargets(
    definitions.map(definition => definition.name),
    context.contributions ?? [],
    Object.fromEntries(definitions.map(definition => [definition.name, databases[definition.name]!.dialect])),
  )
  const definitionDefaults: ResolvedDBViteConfig["definitionDefaults"] = { cloudflareProjections }
  if (options && options.driver === "d1") definitionDefaults.cloudflare = cloudflareOptions(options) ?? {}
  if (options && options.connection) definitionDefaults.connection = options.connection
  return {
    databaseNames: definitions.map(definition => definition.name),
    databases,
    definitionDefaults,
    definitions,
    generatedDrizzleConfigFile: createGeneratedDefinitionPath(rootDir, {
      fileName: "drizzle.config.ts",
      productName: "database",
    }),
    generatedDrizzleConfigFilesByDatabase,
    generatedSchemaFilesByDatabase,
    rootDir,
    tableContributionsByDatabase,
  }
}
