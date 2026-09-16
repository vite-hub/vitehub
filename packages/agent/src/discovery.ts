import { readdirSync, readFileSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  isGitRepositoryDirectory,
  listMatchingFiles,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"
import { parse, string } from "valibot"

import type { DiscoveredAgentDefinition } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"

const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const folderAgentPattern = /^agent\.(?:c|m)?[jt]s$/i
const evalDefinitionPattern = /^(?:.+\.)?eval\.(?:c|m)?[jt]s$/i
const indexDefinitionPattern = /^index\.(?:c|m)?[jt]s$/i
const colocatedAgentResourceDirectories = new Set(["skills"])
const maxAgentNameLength = 512

export const agentEvalFileConvention = {
  include: [
    "**/*.eval.?(m)ts",
    "**/eval.?(m)ts",
    "**/*.eval.tsx",
    "**/eval.tsx",
  ],
  pattern: /^(?:.+\.)?eval\.(?:m?ts|tsx)$/,
}

export function createAgentEvalInclude(rootDirs: string[]): string[] {
  return [...new Set(rootDirs.flatMap((rootDir) => {
    const root = resolve(rootDir)
      .replace(/\\/g, "/")
      .replace(/([*?[\]{}()!])/g, "\\$1")
    return agentEvalFileConvention.include.map(pattern => `${root}/${pattern}`)
  }))].sort()
}

function isColocatedAgentResourcePath(path: string): boolean {
  return colocatedAgentResourceDirectories.has(path.split("/")[0] || "")
}

function isEvalDefinitionFile(file: string): boolean {
  return evalDefinitionPattern.test(basename(file))
}

export function discoverAgentEvalFiles(rootDirs: string[]): string[] {
  return [...new Set(rootDirs.flatMap(rootDir =>
    listMatchingFiles(resolve(rootDir), file => agentEvalFileConvention.pattern.test(file)),
  ))].sort()
}

function normalizeDiscoveredAgentName(name: string): string {
  const normalized = name.trim()
  if (normalized.length > maxAgentNameLength) {
    throw agentDiagnostics.AGENT_R0401({ message: "[vitehub] Agent names cannot exceed 512 characters." })
  }
  return normalized
}

function normalizeSuffixAgentName(rootDir: string, file: string) {
  const name = normalizeSuffixDefinitionName(rootDir, file, agentSuffixPattern, { stripPrefix: "src/" })
  return name.startsWith("server/") ? undefined : normalizeDiscoveredAgentName(name)
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

// Keep literals as single tokens so their punctuation cannot change object depth.
function tokenizeAgentSource(source: string): string[] {
  return source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*|[A-Za-z_$][\w$]*|[^\s]/g)
    ?.filter(token => !token.startsWith("//") && !token.startsWith("/*")) ?? []
}

function isWorkspaceAgentDefinition(source: string): boolean {
  const tokens = tokenizeAgentSource(source)
  const declarations = new Map<string, number>()
  const imported = new Set<string>()
  const importedNamespaces = new Set<string>()
  const importedAgentBindings = new Set<string>()
  const importedCapabilityBindings = new Set<string>()
  const importedChannelBindings = new Set<string>()
  const importedChannelNamespaces = new Set<string>()
  let exported: number | undefined
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (depth === 0) {
      if (tokens[i] === "import") {
        // Dynamic imports are expressions, not static declarations. Ignore
        // them entirely so identifiers in the surrounding module cannot be
        // mistaken for imported Workspace bindings.
        if (tokens[i + 1] === "(") {
          // Skip the complete dynamic import expression; its argument may
          // contain identifiers that must not be treated as static imports.
          let dynamicDepth = 0
          for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j] === "(") dynamicDepth++
            else if (tokens[j] === ")" && --dynamicDepth === 0) {
              i = j
              break
            }
          }
          continue
        }
        // Imports are often semicolonless; stop at the module specifier rather
        // than consuming identifiers from following declarations.
        let sawFrom = false
        let sawStar = false
        for (let j = i + 1; j < tokens.length; j++) {
          const token = tokens[j]
          if (token === "from") { sawFrom = true; continue }
          if (!sawFrom && token === "*") { sawStar = true; continue }
          if (!sawFrom && sawStar && token === "as" && tokens[j + 1]) {
            // Record namespace bindings only for the Agent package import.
            // Local objects may expose a similarly named method.
            let moduleToken: string | undefined
            // Resolve the source only within this import declaration.
            for (let k = j + 2; k < tokens.length; k++) {
              const candidate = tokens[k]
              if (candidate === ";" || candidate === "import" || candidate === "export") break
              if (candidate === "from") {
                const source = tokens[k + 1]
                if (source && /^['"`]/.test(source)) moduleToken = source
                break
              }
            }
            const moduleName = moduleToken?.slice(1, -1)
            if (moduleName === "@vite-hub/agent" || moduleName === "vite-hub/agent") importedNamespaces.add(tokens[j + 1])
            if (moduleName === "@vite-hub/agent/channels" || moduleName === "vite-hub/agent/channels") importedChannelNamespaces.add(tokens[j + 1])
            continue
          }
          if (!sawFrom && /^['"`]/.test(token)) { i = j; break }
          if (sawFrom) {
            if (/^["'`]/.test(token)) {
              const moduleName = token.slice(1, -1)
              if (moduleName === "@vite-hub/agent" || moduleName === "vite-hub/agent") {
                const bindings = tokens.slice(i + 1, j)
                for (let b = 0; b < bindings.length; b++) {
                  if (bindings[b] === "defineAgent") importedAgentBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                  if (bindings[b] === "defineCapability") importedCapabilityBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                }
              }
              if (moduleName === "@vite-hub/agent/channels" || moduleName === "vite-hub/agent/channels") {
                const bindings = tokens.slice(i + 1, j)
                for (let b = 0; b < bindings.length; b++) {
                  if (bindings[b] === "defineChannel") importedChannelBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                }
              }
              i = j; break
            }
            continue
          }
          if (/^[A-Za-z_$]/.test(token) && !["from", "as", "type"].includes(token) && tokens[j + 1] !== "as") imported.add(token)
        }
      }
      if (["const", "let", "var"].includes(tokens[i])) {
        const name = tokens[i + 1]
        let equals = i + 2
        while (equals < tokens.length && tokens[equals] !== "=" && tokens[equals] !== ";" && tokens[equals] !== ",") equals++
        if (name && tokens[equals] === "=") declarations.set(name, equals + 1)
      }
      // Hoisted function declarations are valid callback bindings too. Keep
      // the reference at the `function` token so callback scanning can locate
      // their parameter list and body just like function expressions.
      if (tokens[i] === "function" && tokens[i + 1] && tokens[i + 1] !== "*") {
        declarations.set(tokens[i + 1], i)
      }
      if (tokens[i] === "export" && tokens[i + 1] === "default") exported = i + 2
      if (tokens[i] === "export" && tokens[i + 1] === "{" ) {
        const local = tokens[i + 2]
        if (local && tokens[i + 3] === "as" && tokens[i + 4] === "default") exported = declarations.get(local) ?? i + 2
      }
    }
    if (["{", "(", "["].includes(tokens[i])) depth++
    if (["}", ")", "]"].includes(tokens[i])) depth--
  }

  // A declaration is visible only in its containing scope and descendants.
  const tokenScopes: (number | undefined)[] = []
  const scopeParents = new Map<number, number | undefined>()
  const openingDelimiters = new Map<number, number>()
  const functionScopes = new Set<number>()
  const scopes: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    tokenScopes[i] = scopes.at(-1)
    if (["{", "(", "["].includes(tokens[i])) {
      scopeParents.set(i, scopes.at(-1))
      if (tokens[i] === "{") {
        const parameters = openingDelimiters.get(i - 1)
        const arrowBody = tokens[i - 2] === "=" && tokens[i - 1] === ">"
        const functionBody = tokens[i - 1] === ")" && parameters !== undefined
          && !["if", "for", "while", "switch", "catch", "with"].includes(tokens[parameters - 1])
        if (arrowBody || functionBody) functionScopes.add(i)
      }
      scopes.push(i)
    } else if (["}", ")", "]"].includes(tokens[i])) {
      const opening = scopes.pop()
      if (opening !== undefined) openingDelimiters.set(i, opening)
    }
  }

  function variableScope(index: number): number | undefined {
    let scope = tokenScopes[index]
    while (scope !== undefined && !functionScopes.has(scope)) scope = scopeParents.get(scope)
    return scope
  }

  const callbackParameters: { start: number; end: number; names: Set<string> }[] = []

  function callbackBindingNames(start: number, end: number): Set<string> {
    const names = new Set<string>()
    let cursor = start
    if (tokens[cursor] === "async") cursor++
    if (tokens[cursor] === "function") cursor = tokens.indexOf("(", cursor)
    // Method callbacks may point at their body after parameter scanning.
    if (tokens[cursor] === "{" && tokens[cursor - 1] === ")") {
      let depth = 1
      cursor -= 2
      while (cursor >= 0 && depth) {
        if (tokens[cursor] === ")") depth++
        else if (tokens[cursor] === "(") depth--
        if (depth) cursor--
      }
    }
    function skipValue(close: string) {
      let depth = 0
      let type = tokens[cursor] === ":" || tokens[cursor] === "?"
      for (; cursor < end; cursor++) {
        const token = tokens[cursor]
        if (depth === 0 && (token === "," || token === close)) return
        if (depth === 0 && token === "=") type = false
        if (["(", "[", "{"].includes(token) || (type && token === "<")) depth++
        else if ([")", "]", "}"].includes(token) || (type && token === ">" && tokens[cursor - 1] !== "=")) depth--
      }
    }
    function binding() {
      if (tokens[cursor] === "." && tokens[cursor + 1] === "." && tokens[cursor + 2] === ".") cursor += 3
      const token = tokens[cursor]
      if (token === "{" || token === "[") {
        const close = token === "{" ? "}" : "]"
        cursor++
        while (cursor < end && tokens[cursor] !== close) {
          if (tokens[cursor] === ",") { cursor++; continue }
          if (token === "{" && tokens[cursor] === "[") {
            // Computed property expressions do not introduce bindings.
            let depth = 1
            for (cursor++; cursor < end && depth; cursor++) {
              if (tokens[cursor] === "[") depth++
              else if (tokens[cursor] === "]") depth--
            }
            if (tokens[cursor] === ":") cursor++
          } else if (token === "{" && tokens[cursor + 1] === ":") cursor += 2
          binding()
          skipValue(close)
        }
        cursor++
      } else {
        if (/^[A-Za-z_$][\w$]*$/.test(token ?? "")) names.add(token)
        cursor++
      }
    }
    if (tokens[cursor] !== "(") { binding(); return names }
    cursor++
    while (cursor < end && tokens[cursor] !== ")") {
      if (tokens[cursor] === ",") { cursor++; continue }
      binding()
      skipValue(")")
    }
    return names
  }

  const destructuredBindings = new Map<number, Set<string>>()
  const variableDeclarations = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    if (!["const", "let", "var"].includes(tokens[i])) continue
    variableDeclarations.set(i, i)
    const scope = tokenScopes[i]
    for (let cursor = i + 1; cursor < tokens.length; cursor++) {
      if (tokenScopes[cursor] !== scope) continue
      if ([";", "const", "let", "var", "export", "return", "in", "of", "}", ")"].includes(tokens[cursor])) break
      if (tokens[cursor] === "," && (["[", "{"].includes(tokens[cursor + 1])
        || (/^[A-Za-z_$][\w$]*$/.test(tokens[cursor + 1] ?? "") && ["=", ":", "!"].includes(tokens[cursor + 2])))) {
        variableDeclarations.set(cursor, i)
      }
    }
  }
  for (const binding of variableDeclarations.keys()) {
    if (["[", "{"].includes(tokens[binding + 1])) {
      destructuredBindings.set(binding, callbackBindingNames(binding + 1, tokens.length))
    }
  }

  function visibleDeclaration(index: number): number | undefined {
    const visibleScopes: (number | undefined)[] = []
    for (let scope = tokenScopes[index]; scope !== undefined; scope = scopeParents.get(scope)) visibleScopes.push(scope)
    visibleScopes.push(undefined)
    const parameterScope = callbackParameters.findLast(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))
    for (const scope of visibleScopes) {
      let binding: number | undefined
      for (const [i, declaration] of variableDeclarations) {
        if (i < (parameterScope?.start ?? 0)
          || (tokens[i + 1] !== tokens[index] && !destructuredBindings.get(i)?.has(tokens[index]))) continue
        const bindingScope = tokens[declaration] === "var" ? variableScope(declaration) : tokenScopes[declaration]
        if (bindingScope !== scope) continue
        if (binding === undefined || i < index) binding = i
      }
      if (binding === undefined) continue
      return binding
    }
    return undefined
  }

  function conditionalBranches(index: number): [number, number] | undefined {
    let expressionDepth = 0
    let conditionalDepth = 0
    let consequent: number | undefined
    for (let i = index; i < tokens.length; i++) {
      const token = tokens[i]
      if (expressionDepth === 0) {
        if ([";", ",", ":", "export", "const", "let", "var", ")", "}", "]"].includes(token) && conditionalDepth === 0) break
        if (token === "?" && tokens[i + 1] !== "." && tokens[i + 1] !== "?" && tokens[i - 1] !== "?") {
          if (conditionalDepth === 0) consequent = i + 1
          conditionalDepth++
        }
        if (token === ":" && conditionalDepth > 0 && --conditionalDepth === 0 && consequent !== undefined) {
          return [consequent, i + 1]
        }
      }
      if (["{", "(", "["].includes(token)) expressionDepth++
      if (["}", ")", "]"].includes(token)) expressionDepth--
    }
    return undefined
  }

  function capabilityOwnsWorkspace(index: number, seen = new Set<number>()): boolean {
    if (tokens[index] === "." && tokens[index + 1] === "." && tokens[index + 2] === ".") index += 3
    const outerBranches = conditionalBranches(index)
    if (outerBranches) return outerBranches.some(branch => capabilityOwnsWorkspace(branch, new Set(seen)))
    while (tokens[index] === "(") index++
    if (seen.has(index)) return false
    seen.add(index)
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => capabilityOwnsWorkspace(branch, new Set(seen)))
    if (tokens[index] === "[") {
      let depth = 0
      for (let i = index + 1; i < tokens.length; i++) {
        if (depth === 0 && tokens[i] === "]") break
        if (depth === 0 && (i === index + 1 || tokens[i - 1] === ",") && capabilityOwnsWorkspace(i, new Set(seen))) return true
        if (["{", "(", "["].includes(tokens[i])) depth++
        else if (["}", ")", "]"].includes(tokens[i])) depth--
      }
      return false
    }
    const parameterScope = callbackParameters.findLast(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))
    const binding = visibleDeclaration(index)
    let capabilityCall = binding !== undefined || parameterScope ? -1 : tokens[index] === "defineCapability" || importedCapabilityBindings.has(tokens[index])
      ? index + 1
      : importedNamespaces.has(tokens[index]) && tokens[index + 1] === "." && tokens[index + 2] === "defineCapability"
        ? index + 3
        : -1
    if (tokens[capabilityCall] === "<") capabilityCall = skipTypeArguments(capabilityCall)
    if (tokens[capabilityCall] === "(") {
      const options = properties(capabilityCall + 1)
      const workspace = options.get("workspace")
      if (workspace !== undefined && tokens[resolveReference(workspace)] !== "undefined") return true
      const nested = options.get("capabilities")
      return nested !== undefined && capabilityOwnsWorkspace(nested, seen)
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(tokens[index] ?? "")) return false
    if (binding !== undefined) {
      if (destructuredBindings.has(binding)) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect a destructured Capability binding. Add workspace: {} to the Agent definition when the Capability owns a Workspace, or use a direct local binding so discovery can inspect it.")
      }
      // Later declarations shadow outer bindings before their initializer runs.
      if (binding > index) return false
      let initializer = binding + 2
      while (initializer < index && !["=", ";", ","].includes(tokens[initializer])) initializer++
      return tokens[initializer] === "=" && capabilityOwnsWorkspace(initializer + 1, seen)
    }
    let referenceEnd = index + 1
    while (tokens[referenceEnd] === ".") referenceEnd += 2
    if (!parameterScope && imported.has(tokens[index]) && !["(", "<"].includes(tokens[referenceEnd])) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an imported Capability. Add workspace: {} to the Agent definition when the Capability owns a Workspace, or define the Capability locally so discovery can inspect it.")
    }
    return false
  }

  function skipTypeArguments(index: number): number {
    let angleDepth = 0
    do {
      if (tokens[index] === "<") angleDepth++
      // The tokenizer splits a function type's arrow into two tokens.
      if (tokens[index] === ">" && tokens[index - 1] !== "=") angleDepth--
      index++
    } while (index < tokens.length && angleDepth > 0)
    return index
  }

  function memberCallEnd(index: number): number {
    let end = index + 1
    let wrappers = 0
    for (let i = index - 1; tokens[i] === "("; i--) wrappers++
    while (end < tokens.length) {
      if (tokens[end] === "!") { end++; continue }
      if (tokens[end] === "?" && tokens[end + 1] === ".") {
        end += 2
        if (!["(", "[", "<"].includes(tokens[end])) end++
        continue
      }
      if (tokens[end] === ".") { end += 2; continue }
      if (tokens[end] === "[") {
        let depth = 1
        for (end++; end < tokens.length && depth > 0; end++) {
          if (tokens[end] === "[") depth++
          else if (tokens[end] === "]") depth--
        }
        continue
      }
      if (tokens[end] === "<") { end = skipTypeArguments(end); continue }
      if (tokens[end] === "as" || tokens[end] === "satisfies") {
        // A parenthesized assertion preserves the callable expression. Skip
        // its type, including nested function types, until the wrapper closes.
        let depth = 0
        for (end++; end < tokens.length; end++) {
          const token = tokens[end]
          if (depth === 0 && [")", ",", ";", "}"].includes(token)) break
          if (["(", "[", "{", "<"].includes(token)) depth++
          else if ([")", "]", "}", ">"].includes(token) && tokens[end - 1] !== "=") depth--
        }
        continue
      }
      if (tokens[end] === ")" && wrappers > 0) { wrappers--; end++; continue }
      break
    }
    return end
  }

  function resolveReference(index: number, seen = new Set<number>(), preserveCalls = false): number {
    while (tokens[index] === "(" || tokens[index] === "<") {
      index = tokens[index] === "<" ? skipTypeArguments(index) : index + 1
    }
    if (seen.has(index)) return index
    seen.add(index)
    if (preserveCalls) {
      const call = memberCallEnd(index)
      if (tokens[call] === "(") return index
    }
    const binding = visibleDeclaration(index)
    if (binding !== undefined) {
      if (destructuredBindings.has(binding)) return index
      if (binding > index) return index
      let initializer = binding + 2
      while (initializer < index && !["=", ";", ","].includes(tokens[initializer])) initializer++
      return tokens[initializer] === "=" ? resolveReference(initializer + 1, seen, preserveCalls) : index
    }
    if (callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))) return index
    const reference = declarations.get(tokens[index])
    return reference === undefined ? index : resolveReference(reference, seen, preserveCalls)
  }

  function propertyName(token: string): string {
    if (!/^["'`]/.test(token)) return token
    if (token[0] === '`') return token.slice(1, -1)
    try {
      const value: unknown = token[0] === '"'
        ? JSON.parse(token)
        : JSON.parse(`"${token.slice(1, -1).replace(/\\"/g, '\\\\"')}"`)
      return parse(string(), value)
    } catch {
      return token.slice(1, -1)
    }
  }

  function properties(index: number, inspectChannels = false, inspectSettings = false): Map<string, number> {
    const result = new Map<string, number>()
    index = resolveReference(index)
    // Preserve object literals wrapped in value-preserving helpers such as
    // Object.freeze({ ... }).
    if (tokens[index + 1] === "." && tokens[index + 2] === "freeze" && tokens[index + 3] === "(") {
      index = resolveReference(index + 4)
    }
    if (inspectChannels && imported.has(tokens[index]) && visibleDeclaration(index) === undefined
      && !callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))) {
      let referenceEnd = index + 1
      while (tokens[referenceEnd] === ".") referenceEnd += 2
      if (!["(", "<"].includes(tokens[referenceEnd])) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an imported Channel. Add workspace: {} to the Agent definition when the Channel owns a Workspace, or define the Channel locally so discovery can inspect it.")
      }
    }
    if (tokens[index] !== "{") {
      if (inspectSettings) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect opaque Agent settings. Define settings locally, or add an explicit workspace: {} ownership marker or named Workspace reference to the Agent definition.")
      }
      return result
    }
    let depth = 0
    let atProperty = true
    for (let i = index + 1; i < tokens.length; i++) {
      const token = tokens[i]
      if (depth === 0 && token === "}") break
      if (depth === 0 && atProperty) {
        if (token === "." && tokens[i + 1] === "." && tokens[i + 2] === ".") {
          const spread = properties(i + 3, inspectChannels, inspectSettings)
          for (const [key, value] of spread) result.set(key, value)
          i += 2
          atProperty = false
        } else if (token === "[") {
          // Computed keys may reference a statically-resolvable identifier.
          // Locate the matching bracket rather than assuming a fixed token
          // layout (parentheses and other expressions are valid here).
          let close = i + 1
          let bracketDepth = 1
          while (close < tokens.length && bracketDepth > 0) {
            if (tokens[close] === "[") bracketDepth++
            else if (tokens[close] === "]") bracketDepth--
            close++
          }
          if (bracketDepth === 0 && (tokens[close] === ":" || tokens[close] === "(")) {
            const expression = tokens.slice(i + 1, close - 1).filter(token => token !== "(" && token !== ")")
            let key: string | undefined
            const literalParts: string[] = []
            let valid = true
            for (let p = 0; p < expression.length; p += 2) {
              const part = expression[p]
              if (!part) { valid = false; break }
              const partIndex = tokens.indexOf(part, i + 1)
              const resolved = partIndex >= 0 ? resolveReference(partIndex) : partIndex
              const value = resolved >= 0 ? tokens[resolved] : part
              if (!value || !/^["'`]/.test(value) || (value.startsWith("`") && (value.includes("${") || value.includes("\\")))) { valid = false; break }
              literalParts.push(propertyName(value))
              if (p + 1 < expression.length && expression[p + 1] !== "+") { valid = false; break }
            }
            if (valid && literalParts.length) key = literalParts.join("")
            let valueIndex = close + 1
            if (tokens[close] === "(") {
              // Skip the complete parameter list (including destructuring)
              // and point directly at the method body so callback discovery
              // cannot mistake a parameter object for the returned Agent.
              let parameters = 1
              while (valueIndex < tokens.length && parameters > 0) {
                if (tokens[valueIndex] === "(") parameters++
                else if (tokens[valueIndex] === ")") parameters--
                valueIndex++
              }
            }
            if (key === undefined && inspectSettings) {
              throw new Error("[vitehub] Agent Workspace discovery cannot inspect a computed Agent settings key. Use a literal key, or add an explicit workspace: {} ownership marker or named Workspace reference to the configured Agent definition.")
            }
            if (key !== undefined) result.set(key, valueIndex)
            // Account for a computed method parameter list explicitly. The
            // opener is consumed while locating the key, so seed depth before
            // continuing after it; otherwise the closing `)` would underflow
            // the enclosing object scan and hide following sibling fields.
            i = close
            atProperty = false
          }
        } else if (tokens[i + 1] === ":") result.set(propertyName(token), i + 2)
        else if ([",", "}"].includes(tokens[i + 1])) result.set(propertyName(token), i)
        // Object method shorthand (e.g. `configure() { ... }`) has no colon;
        // retain the method's opening parenthesis so callback discovery can
        // inspect its body just like an arrow or function expression.
        else if (tokens[i + 1] === "(") result.set(propertyName(token), i + 1)
        atProperty = false
      }
      if (depth === 0 && token === ",") atProperty = true
      if (["{", "(", "["].includes(token)) depth++
      if (["}", ")", "]"].includes(token)) depth--
    }
    return result
  }

  function factoryCall(index: number, name: "defineAgent" | "defineChannel" = "defineAgent"): number | undefined {
    const reference = resolveReference(index)
    if (visibleDeclaration(reference) !== undefined || callbackParameters.some(scope =>
      reference >= scope.start && reference < scope.end && scope.names.has(tokens[reference]))) return undefined
    // A binding to an Agent value is not an alias of the factory itself.
    let identityEnd = reference + 1
    while (tokens[identityEnd] === ".") identityEnd += 2
    if (tokens[identityEnd] === "<") identityEnd = skipTypeArguments(identityEnd)
    if (reference !== index && tokens[identityEnd] === "(") return undefined
    let scope = tokenScopes[reference]
    while (true) {
      if (tokens.some((token, declaration) => {
        if (token !== "function" && token !== "class") return false
        const preceding = tokens[declaration - 1] === "async" ? declaration - 2 : declaration - 1
        if (["=", "(", "return", ":", ",", ">"].includes(tokens[preceding])) return false
        return tokens[declaration + 1] === tokens[reference] && tokenScopes[declaration] === scope
      })) return undefined
      if (scope === undefined) break
      scope = scopeParents.get(scope)
    }
    const factory = tokens[reference]
    const bindings = name === "defineAgent" ? importedAgentBindings : importedChannelBindings
    const namespaces = name === "defineAgent" ? importedNamespaces : importedChannelNamespaces
    if (!(factory === name && !imported.has(factory)) && !bindings.has(factory) &&
        !(namespaces.has(factory) && tokens[reference + 1] === "." && tokens[reference + 2] === name)) return undefined
    let call = index + 1
    while (tokens[call] === ".") call += 2
    if (tokens[call] === "<") call = skipTypeArguments(call)
    return tokens[call] === "(" ? call : undefined
  }

  function ownsWorkspace(index: number, seen = new Set<number>(), inspectParent = false): boolean {
    index = resolveReference(index, new Set(), true)
    if (seen.has(index)) return false
    seen.add(index)
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => ownsWorkspace(branch, new Set(seen), inspectParent))
    const call = factoryCall(index)
    if (call === undefined) {
      if (inspectParent && imported.has(tokens[index]) && visibleDeclaration(index) === undefined
        && !callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an imported Agent parent. Add workspace: {} to the Agent definition when the parent owns a Workspace, or define the parent locally so discovery can inspect it.")
      }
      return false
    }
    const options = properties(call + 1)
    const workspace = options.get("workspace")
    if (workspace !== undefined && tokens[resolveReference(workspace)] !== "undefined") {
      function workspaceOwnsDefinition(index: number): boolean {
        const value = resolveReference(index)
        const branches = conditionalBranches(value)
        if (branches) return branches.some(workspaceOwnsDefinition)
        if (tokens[value] === "{") {
          const name = properties(value).get("name")
          if (name === undefined) return true
          const nameValue = resolveReference(name)
          if (tokens[nameValue] === "undefined") return true
          if (/^["'`]/.test(tokens[nameValue] ?? "")) return false
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a dynamic Workspace name. Use a statically known string reference or workspace: {} ownership marker.")
        }
        if (tokens[value] === "undefined" || /^["'`]/.test(tokens[value] ?? "")) return false
        // A dynamic member may resolve to either a named reference or owned
        // storage. Require an explicit contract instead of guessing ownership.
        const optionBinding = callbackParameters.some(scope => value >= scope.start && value < scope.end && scope.names.has(tokens[value]))
        if (optionBinding || tokens[value + 1] === "." || tokens[value + 1] === "[") {
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a dynamic Workspace value. Add an explicit workspace: {} ownership marker or named Workspace reference to the configured Agent definition.")
        }
        return true
      }
      return workspaceOwnsDefinition(workspace)
    }

    // Unknown spreads can supply Workspace settings even when no visible field does.
    // An explicit Workspace marker above provides the required ownership contract.
    properties(call + 1, false, true)
    const capabilities = options.get("capabilities")
    if (capabilities !== undefined && capabilityOwnsWorkspace(capabilities)) return true
    const channels = options.get("channels")
    if (channels !== undefined) {
      for (const channel of properties(channels, true).values()) {
        let channelOptions = resolveReference(channel, new Set(), true)
        const channelCall = factoryCall(channelOptions, "defineChannel")
        if (channelCall !== undefined) {
          // defineChannel(kind, options) contributes the options of this invocation.
          let depth = 0
          for (let i = channelCall + 1; i < tokens.length; i++) {
            if (depth === 0 && tokens[i] === ")") break
            if (depth === 0 && tokens[i] === ",") { channelOptions = i + 1; break }
            if (["{", "(", "["].includes(tokens[i])) depth++
            else if (["}", ")", "]"].includes(tokens[i])) depth--
          }
        }
        const capabilities = properties(channelOptions, true).get("capabilities")
        if (capabilities !== undefined && capabilityOwnsWorkspace(capabilities)) return true
      }
    }
    const inherited = options.get("extends")
    if (inherited !== undefined && ownsWorkspace(inherited, seen, true)) return true
    const preset = options.get("preset")
    const registry = options.get("presets")
    const configure = options.get("configure")
    if (configure !== undefined) {
      // A configure callback may return an existing Agent binding directly;
      // follow that binding so its Workspace metadata is preserved.
      let callbackStart = configure
      const callbackReferences = new Set<number>()
      while (declarations.has(tokens[callbackStart]) && !callbackReferences.has(callbackStart)
        && !(tokens[callbackStart + 1] === "=" && tokens[callbackStart + 2] === ">")) {
        callbackReferences.add(callbackStart)
        callbackStart = declarations.get(tokens[callbackStart])!
      }
      const configuredReference = tokens[callbackStart + 1] === "=" && tokens[callbackStart + 2] === ">"
        ? callbackStart
        : resolveReference(configure)
      let parameterEnd = configuredReference + 1
      if (tokens[callbackStart] === "(") {
        let depth = 0
        for (let i = callbackStart; i < tokens.length; i++) {
          if (tokens[i] === "(") depth++
          else if (tokens[i] === ")" && --depth === 0) { parameterEnd = i + 1; break }
        }
      }
      const importedCallback = imported.has(tokens[configuredReference])
        && !(tokens[parameterEnd] === "=" && tokens[parameterEnd + 1] === ">")
      if (importedCallback) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an imported configure callback. Define configure locally in the Agent file and return a discoverable defineAgent() call.")
      }
      if (configuredReference !== configure && ownsWorkspace(configuredReference, new Set(seen))) return true
      // Computed and shorthand methods record the parameter-list opening;
      // do not resolve through it or destructured parameters can be mistaken for the body.
      let start = tokens[callbackStart] === "(" ? callbackStart : configuredReference
      // Scan the Agent definition returned by the callback, rather than the
      // callback's parameter list (which commonly contains parentheses).
      // Prefer the definition expression in the callback body. A callback's
      // parameter list may itself contain parentheses, so starting the scan
      // at the first token after `configure` can terminate before the body.
      // Skip callback parameters and locate a definition in the callback body.
      // Shorthand methods resolve to their parameter-list opening token;
      // handle those bounds before searching for arrows elsewhere in the module.
      let methodBodyStart = -1
      if (tokens[start] === "{") methodBodyStart = start
      if (tokens[start] === ")") {
        // Method shorthand references resolve to the closing parameter token.
        // Rewind to its opening delimiter before locating the method body.
        let depth = 0
        for (let i = start; i >= 0; i--) {
          if (tokens[i] === ")") depth++
          else if (tokens[i] === "(" && --depth === 0) {
            start = i
            break
          }
        }
      }
      if (tokens[start] === "(") {
        let depth = 0
        let parameterEnd = start
        for (; parameterEnd < tokens.length; parameterEnd++) {
          if (tokens[parameterEnd] === "(") depth++
          else if (tokens[parameterEnd] === ")" && --depth === 0) { parameterEnd++; break }
        }
        if (tokens[parameterEnd] === "{") methodBodyStart = parameterEnd
      }
      const arrow = methodBodyStart < 0 ? (() => {
        let depth = 0
        for (let i = start; i + 1 < tokens.length; i++) {
          const token = tokens[i]
          if (["(", "[", "{"].includes(token)) depth++
          else if ([")", "]", "}"].includes(token)) { if (depth === 0) break; depth-- }
          else if ((token === ";" || token === ",") && depth === 0) break
          if (tokens[i] === "=" && tokens[i + 1] === ">") return i
        }
        return -1
      })() : -1
      let bodyStart = arrow >= 0 ? arrow + 1 : (methodBodyStart >= 0 ? methodBodyStart : start)
      // Limit the search to this callback's body so later module declarations
      // cannot be mistaken for its returned definition.
      let callbackEnd = tokens.length
      if (arrow < 0) {
        // Method or function callbacks have a parameter list followed by a
        // block body; skip the parameters and bound scanning to that block.
        let parameterEnd = start
        if (tokens[parameterEnd] === "(") {
          let depth = 0
          for (; parameterEnd < tokens.length; parameterEnd++) {
            if (tokens[parameterEnd] === "(") depth++
            else if (tokens[parameterEnd] === ")" && --depth === 0) { parameterEnd++; break }
          }
        }
        const body = tokens.indexOf("{", parameterEnd)
        if (body >= 0) {
          start = body
          bodyStart = body
          for (let i = body + 1, depth = 1; i < tokens.length; i++) {
            if (tokens[i] === "{") depth++
            else if (tokens[i] === "}" && --depth === 0) { callbackEnd = i + 1; break }
          }
        }
      } else {
        let bodyDepth = 0
        for (let i = bodyStart; i < tokens.length; i++) {
          const token = tokens[i]
          if (["{", "(", "["].includes(token)) bodyDepth++
          else if (["}", ")", "]"].includes(token)) {
            if (bodyDepth === 0) { callbackEnd = i; break }
            bodyDepth--
            if (bodyDepth === 0) { callbackEnd = i + 1; break }
          }
        }
      }
      // Callback parameters shadow module bindings. Local declarations inside
      // the body remain eligible, but lookup must not escape past a parameter.
      const parametersEnd = arrow >= 0 ? arrow : bodyStart
      const parameterNames = callbackBindingNames(callbackStart, parametersEnd)
      callbackParameters.push({ start: bodyStart, end: callbackEnd, names: parameterNames })
      // Select the returned definition call itself. Nested settings may contain
      // helper `defineAgent` calls; choosing the last token would mistake those
      // helpers for the callback result.
      let callbackDefinition = -1
      let callbackDefinitionDepth = Number.POSITIVE_INFINITY
      let returnedDefinition = -1
      let returnedDefinitionDepth = Number.POSITIVE_INFINITY
      const returnedDefinitions: number[] = []
      let callbackDepth = 0
      let returnExpression = false
      const body = tokens[bodyStart] === ">" ? bodyStart + 1 : bodyStart
      const callbackScope = variableScope(tokens[body] === "{" ? body + 1 : body)
      for (let i = bodyStart; i < callbackEnd; i++) {
        const token = tokens[i]
        const inCallbackScope = variableScope(i) === callbackScope
        const reference = resolveReference(i, new Set(), true)
        const callEnd = memberCallEnd(reference)
        const opaqueCall = /^[A-Za-z_$][\w$]*$/.test(tokens[reference] ?? "") && tokens[callEnd] === "("
          && conditionalBranches(reference) === undefined
        if (inCallbackScope && (factoryCall(reference) !== undefined || opaqueCall)) {
          let expressionStart = i
          while (tokens[expressionStart - 1] === "(") expressionStart--
          const expressionDepth = callbackDepth - (i - expressionStart)
          // A returned expression may contain conditional branches; keep all
          // defineAgent calls until the expression terminates rather than only
          // accepting the token immediately following `return`.
          // Expression-bodied arrows return their sole top-level expression
          // without a `return` token; the callbackEnd bound keeps this from
          // capturing unrelated definitions later in the module.
          const expressionBody = arrow >= 0 && expressionDepth === 0 && !returnExpression
          const returned = (returnExpression && expressionDepth === 0) || expressionBody ||
            // In an expression-bodied arrow, later comma operands are also
            // part of the returned expression; only the final operand is the
            // callback value (the fallback below selects it).
            (arrow >= 0 && !returnExpression && callbackDepth === 0 && tokens[i - 1] === ",") ||
            tokens[expressionStart - 1] === "return" || tokens[expressionStart - 1] === "?" || tokens[expressionStart - 1] === ":"
          if (returned) {
            if (expressionDepth < returnedDefinitionDepth) {
              returnedDefinitionDepth = expressionDepth
              returnedDefinition = i
            }
            // Keep every call in the returned expression. Conditional branches
            // may be nested in parentheses and therefore have different token
            // depths, but each remains a possible callback result.
            returnedDefinitions.push(i)
          } else if (!returned && returnedDefinition < 0 && callbackDepth < callbackDefinitionDepth) {
            callbackDefinition = i
            callbackDefinitionDepth = callbackDepth
          }
        }
        if (token === "return" && inCallbackScope) returnExpression = true
        else if ((token === "?" || token === ":") && returnExpression) returnExpression = true
        else if (token === ";" && callbackDepth === 0) returnExpression = false
        if (["{", "(", "["].includes(token)) callbackDepth++
        else if (["}", ")", "]"].includes(token)) callbackDepth--
      }
      // Exclude defineAgent calls nested inside the selected definition's settings.
      // Conditional branches remain eligible when they occur at the same expression depth.
      const returnedCandidates = returnedDefinitions.filter((index) => {
        let depth = 0
        for (let i = bodyStart; i < index; i++) {
          if (["{", "(", "["].includes(tokens[i])) depth++
          else if (["}", ")", "]"].includes(tokens[i])) depth--
        }
        let expressionStart = index
        while (tokens[expressionStart - 1] === "(") expressionStart--
        depth -= index - expressionStart
        // Keep the outer returned call and direct conditional branch calls;
        // nested calls inside its argument object are never callback results.
        // Conditional branches are one delimiter level inside the returned
        // expression (for example `return ok ? defineAgent(...) : ...`).
        // Property values in the returned definition are deeper still; even
        // when preceded by `:`, they are nested settings rather than results.
        if (depth === returnedDefinitionDepth) return true
        if (depth !== returnedDefinitionDepth + 1 || tokens[index - 1] !== ":") return false
        // A colon inside the returned Agent's settings is not a conditional
        // branch. Only retain it when a matching top-level `?` precedes it.
        let nested = 0
        for (let j = index - 2; j >= bodyStart; j--) {
          if (["}", ")", "]"].includes(tokens[j])) nested++
          else if (["{", "(", "["].includes(tokens[j])) { if (nested > 0) nested--; else break }
          else if (tokens[j] === "?" && nested === 0) {
            let qDepth = 0
            for (let k = bodyStart; k < j; k++) {
              if (["{", "(", "["].includes(tokens[k])) qDepth++
              else if (["}", ")", "]"].includes(tokens[k])) qDepth--
            }
            // Parenthesized conditional branches may sit deeper than the
            // outer returned call. Keep the branch when its question mark is
            // at or above the selected return depth; nested settings
            // conditionals remain deeper and are excluded.
            return qDepth <= returnedDefinitionDepth
          }
          else if (tokens[j] === ";" && nested === 0) break
        }
        return false
      })
      returnedDefinitions.splice(0, returnedDefinitions.length, ...returnedCandidates)
      // An expression-bodied arrow returns the final operand of a comma
      // expression; earlier operands are evaluated only for side effects.
      if (arrow >= 0 && !tokens.slice(bodyStart, callbackEnd).includes("return") &&
          !tokens.slice(bodyStart, callbackEnd).includes("?") && returnedDefinitions.length > 1) {
        returnedDefinitions.splice(0, returnedDefinitions.length, returnedDefinitions.at(-1)!)
      }
      // Expression-bodied arrows return their direct definition without a
      // `return` token; retain that callback result for ownership analysis.
      if (returnedDefinitions.length === 0 && arrow >= 0 && tokens[bodyStart + 1] !== "{" && callbackDefinition >= 0) {
        returnedDefinitions.push(callbackDefinition)
      }
      // Only callback results contribute ownership. Inspect their Capability
      // values structurally, never property keys or unrelated settings.
      for (const index of returnedDefinitions) {
        if (factoryCall(resolveReference(index, new Set(), true)) === undefined) {
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a configure result factory. Return a discoverable defineAgent() call, or add an explicit workspace: {} ownership marker or named Workspace reference to the configured Agent definition.")
        }
      }
      if (returnedDefinitions.some((index) => ownsWorkspace(index, new Set(seen)))) return true
    }
    if (preset === undefined || registry === undefined) return false
    const selection = tokens[resolveReference(preset)]
    if (!/^["'`]/.test(selection)) {
      // Runtime-dependent selections cannot identify a registry entry safely.
      return false
    }
    const entry = properties(registry).get(propertyName(selection))
    return entry !== undefined && ownsWorkspace(entry, seen, true)
  }

  // The default export owns the folder; helper definitions and unselected presets do not.
  if (exported !== undefined) return ownsWorkspace(exported)
  return tokens.some((token, index) => token === "defineAgent" && ownsWorkspace(index))
}
function isAgentDefinitionSource(source: string): boolean {
  const stripped = stripComments(source)
  return /\bdefineAgent\s*\(/.test(stripped)
    || /\bexport\s*\{\s*default\s*\}\s*from\b/.test(stripped)
    || /\bexport\s+default\s+\w*Agent\b/.test(stripped)
}

function isInsideFolderAgent(file: string, folderAgentDirs: Set<string>): boolean {
  const directory = dirname(file)
  if (folderAgentDirs.has(directory) && indexDefinitionPattern.test(basename(file))) return false
  if (isAgentDefinitionSource(readFileSync(file, "utf8"))) return false
  for (const agentDir of folderAgentDirs) {
    const path = relative(agentDir, directory)
    if (path === "" || (!path.startsWith("..") && path !== "..")) return true
  }
  return false
}

function isWorkspaceSourceConfig(file: string, folderAgentDirs: Set<string>): boolean {
  const directory = dirname(file)
  for (const agentDir of folderAgentDirs) {
    const path = relative(agentDir, directory).replace(/\\/g, "/")
    if (!path || path.startsWith("../") || path === "..") continue
    if (path.split("/")[0] === "workspace") return true
  }
  return false
}

function discoverFolderAgentDefinitions(scanDirs: string[]): DiscoveredAgentDefinition[] {
  const candidates: DiscoveredAgentDefinition[] = []

  const walk = (agentsRoot: string, current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch (error) {
      // SAFETY: Node filesystem errors expose `code`; other errors simply fail this comparison.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    for (const entry of entries) {
      const file = resolve(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
        if (isGitRepositoryDirectory(file)) continue
        walk(agentsRoot, file)
        continue
      }

      if (!entry.isFile() || (!folderAgentPattern.test(basename(file)) && !indexDefinitionPattern.test(basename(file)))) continue
      const source = readFileSync(file, "utf8")
      const agent = normalizeDiscoveredAgentName(relative(agentsRoot, dirname(file)).replace(/\\/g, "/"))
      if (!agent || agent === ".") continue
      const workspace = isWorkspaceAgentDefinition(source)
      candidates.push({
        handler: file,
        name: agent,
        source: workspace ? "server-agent-workspace" : "server-agents",
        workspace: workspace ? agent : undefined,
      })
    }
  }

  for (const scanDir of scanDirs) {
    walk(resolve(scanDir, "agents"), resolve(scanDir, "agents"))
  }

  const ownedResourceEntries = new Set(candidates.flatMap(definition => candidates.some(parent => {
    if (parent === definition) return false
    const path = relative(dirname(parent.handler), dirname(definition.handler)).replace(/\\/g, "/")
    return isColocatedAgentResourcePath(path)
  }) ? [definition.handler] : []))
  const nestedHelperIndexes = new Set(candidates.flatMap(definition => indexDefinitionPattern.test(basename(definition.handler))
    && !isAgentDefinitionSource(readFileSync(definition.handler, "utf8"))
    && candidates.some((parent) => {
      if (parent === definition) return false
      const path = relative(dirname(parent.handler), dirname(definition.handler)).replace(/\\/g, "/")
      return path !== "" && path !== ".." && !path.startsWith("../")
    })
    ? [definition.handler]
    : []))
  const discoveredCandidates = candidates.filter(definition => !ownedResourceEntries.has(definition.handler) && !nestedHelperIndexes.has(definition.handler))
  const folderAgentDirs = new Set(discoveredCandidates
    .filter(definition => definition.source === "server-agent-workspace")
    .map(definition => dirname(definition.handler)))
  return discoveredCandidates.filter(definition => !isWorkspaceSourceConfig(definition.handler, folderAgentDirs))
}

export function discoverAgentDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "server-agents", scanDirs: string[] }
): DiscoveredAgentDefinition[] {
  if (options.mode === "server-agents") {
    const folderDefinitions = discoverFolderAgentDefinitions(options.scanDirs)
    const folderAgentDirs = new Set(folderDefinitions.map(definition => dirname(definition.handler)))
    const directoryDefinitions = discoverDefinitions("agent", [
      createDirectoryDefinitionSource<DiscoveredAgentDefinition>("server-agents", options.scanDirs, "agents", {
        normalizeName(directory, file) {
          const fileName = basename(file)
          if (folderAgentPattern.test(fileName) && dirname(file) !== directory) return
          if (indexDefinitionPattern.test(fileName) || isEvalDefinitionFile(file)) return
          for (const agentDir of folderAgentDirs) {
            const path = relative(agentDir, file).replace(/\\/g, "/")
            if (isColocatedAgentResourcePath(path)) return
          }
          if (isInsideFolderAgent(file, folderAgentDirs)) return
          return normalizeDiscoveredAgentName(relative(directory, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, ""))
        },
        createDefinition({ file, name }) {
          return {
            handler: file,
            name,
            source: "server-agents",
          }
        },
      }),
    ])

    return mergeDefinitions("agent", directoryDefinitions, folderDefinitions)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return discoverDefinitions("agent", [{
    kind: "suffix",
    normalizeName: normalizeSuffixAgentName,
    pattern: agentSuffixPattern,
    roots: [...roots].map(root => resolve(root)),
    source: "vite-suffix",
  }])
}
