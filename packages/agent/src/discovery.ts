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

function isIdentifier(token: string | undefined): boolean {
  return !!token && /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(token)
}

// Keep literals as single tokens so their punctuation cannot change object depth.
const agentTokenPattern = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*|(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?|(?:[\p{ID_Start}$_]|\\u\{[\da-fA-F]+\}|\\u[\da-fA-F]{4})(?:(?:[\p{ID_Continue}$\u200C\u200D])|(?:\\u\{[\da-fA-F]+\}|\\u[\da-fA-F]{4}))*|[^\s]/gu

function endsAgentExpression(tokens: string[]): boolean {
  function closesControlCondition(index: number): boolean {
    if (tokens[index] !== ")") return false
    let depth = 0
    for (let cursor = index; cursor >= 0; cursor--) {
      if (tokens[cursor] === ")") depth++
      else if (tokens[cursor] === "(") {
        depth--
        if (depth === 0) return ["if", "for", "while", "switch", "catch", "with"].includes(tokens[cursor - 1] ?? "")
      }
    }
    return false
  }
  const previous = tokens.at(-1)
  return previous !== undefined && (
    /^(?:\d|\.\d|["'`]|\/.)/.test(previous) || ([")", "]", "}"].includes(previous) && !closesControlCondition(tokens.length - 1))
    || (["+", "-"].includes(previous) && tokens.at(-2) === previous)
    || (isIdentifier(previous) && !["return", "throw", "yield", "await", "case", "else", "in", "of", "instanceof", "typeof", "void", "delete", "new"].includes(previous))
  )
}

// Read nested templates as one token and expose only their executable regions.
function readAgentTemplate(source: string, start: number): { end: number, expressions: string[] } {
  const expressions: string[] = []
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2
      continue
    }
    if (source[cursor] === "`") return { end: cursor + 1, expressions }
    if (source[cursor] !== "$" || source[cursor + 1] !== "{") {
      cursor++
      continue
    }
    const expressionStart = cursor + 2
    const pattern = new RegExp(agentTokenPattern.source, agentTokenPattern.flags)
    pattern.lastIndex = expressionStart
    let depth = 1
    const expressionTokens: string[] = []
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      let token = match[0]
      if (token.startsWith("//") || token.startsWith("/*")) continue
      if (token.startsWith("/") && token.length > 1 && endsAgentExpression(expressionTokens)) {
        token = "/"
        pattern.lastIndex = match.index + 1
      }
      expressionTokens.push(token)
      if (token.startsWith("`")) {
        pattern.lastIndex = readAgentTemplate(source, match.index).end
      }
      else if (token === "{") depth++
      else if (token === "}") depth--
      if (depth === 0) {
        expressions.push(source.slice(expressionStart, match.index))
        cursor = pattern.lastIndex
        break
      }
    }
    if (depth !== 0) return { end: source.length, expressions }
  }
  return { end: source.length, expressions }
}

function templateReferences(template: string, lineBreaks = new Set<number>()): string[] {
  const references: string[] = []
  for (const expression of readAgentTemplate(template, 0).expressions) {
    const parsed = tokenizeAgentSource(expression)
    for (let index = 0; index < parsed.tokens.length; index++) {
      if (parsed.lineBreaks.has(index)) lineBreaks.add(references.length)
      const token = parsed.tokens[index]!
      references.push(token)
      if (token.startsWith("`")) {
        references.push(";", "(")
        const nestedBreaks = new Set<number>()
        const nested = templateReferences(token, nestedBreaks)
        for (const boundary of nestedBreaks) lineBreaks.add(references.length + boundary)
        references.push(...nested, ")")
      }
    }
    references.push(";")
  }
  return references
}

export function tokenizeAgentSource(source: string): { tokens: string[], lineBreaks: Set<number> } {
  const tokens: string[] = []
  const lineBreaks = new Set<number>()
  let previousEnd = 0
  const tokenPattern = new RegExp(agentTokenPattern.source, agentTokenPattern.flags)
  for (let match = tokenPattern.exec(source); match !== null; match = tokenPattern.exec(source)) {
    let token = match[0]
    if (token.startsWith("`")) {
      tokenPattern.lastIndex = readAgentTemplate(source, match.index).end
      token = source.slice(match.index, tokenPattern.lastIndex)
    }
    if (token.startsWith("//") || token.startsWith("/*")) continue
    if (/[\r\n\u2028\u2029]/.test(source.slice(previousEnd, match.index))) lineBreaks.add(tokens.length)
    const endsExpression = endsAgentExpression(tokens)
    // A slash after an expression divides it. Expose operands that the
    // regex-literal matcher would otherwise hide, including option writes.
    if (token.startsWith("/") && token.length > 1 && endsExpression) {
      token = "/"
      tokenPattern.lastIndex = match.index + 1
    }
    // Identifier escapes name the same bindings and properties at runtime.
    tokens.push(/^[\p{ID_Start}$_\\]/u.test(token)
      ? token.replace(/\\u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))/g, (_escape, point: string | undefined, unit: string | undefined) => String.fromCodePoint(Number.parseInt(point ?? unit!, 16)))
      : token)
    previousEnd = match.index + token.length
  }
  return { tokens, lineBreaks }
}

// Decode ESM string literals without executing the source module.
function moduleSpecifier(token: string | undefined): string {
  if (!token) return ""
  const body = token.slice(1, -1)
  // Legacy octal and decimal escapes are invalid in strict-mode modules.
  if (/\\(?:[89]|[1-7][0-7]?|0[0-7]|0(?=[0-9]))/.test(body)) return ""
  const escapes: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" }
  return body.replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (_match, codePoint: string | undefined, unicode: string | undefined, hex: string | undefined, continuation: string | undefined, escaped: string | undefined) => {
      const code = codePoint ?? unicode ?? hex
      if (code !== undefined) return String.fromCodePoint(Number.parseInt(code, 16))
      if (continuation !== undefined) return ""
      return escapes[escaped!] ?? escaped!
    })
}

function invalidModuleLiteral(token: string | undefined): boolean {
  return !!token && /^['"]/.test(token) && /\\(?:[89]|[1-7][0-7]?|0[0-7]|0(?=[0-9]))/.test(token.slice(1, -1))
}

// First-party Channel helpers from the Agent Channel entry. Only `github()`
// adds a Capability of its own: the pull request Workspace. The other helpers
// contribute only the Capabilities passed in their `capabilities` option.
const firstPartyCapabilityFactories = new Set(["blob", "db", "usage", "transcribe"])
const firstPartyChannelFactories = new Set(["discord", "github", "gitlab", "forgejo", "http", "slack", "teams", "telegram", "webChat"])
const channelModuleExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

function importedChannelError(): Error {
  return new Error("[vitehub] Agent Workspace discovery cannot inspect an imported Channel. Import the Channel from a relative module that exports a local Channel object or a first-party Channel helper call, or add workspace: {} to the Agent definition when the Channel owns a Workspace.")
}

// Resolves a relative Channel module like TypeScript bundler resolution,
// including `.js` specifiers that name a `.ts` source file.
function resolveChannelModule(importer: string, specifier: string): { file: string, source: string } | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return
  const base = resolve(dirname(importer), specifier)
  const sourceBases = [
    base.replace(/\.(c|m)?js$/, ".$1ts"),
    base.replace(/\.(c|m)?js$/, ".$1tsx"),
    base.replace(/\.jsx$/, ".tsx"),
  ].filter(candidate => candidate !== base)
  const candidates = [
    base,
    ...sourceBases,
    ...channelModuleExtensions.map(extension => `${base}${extension}`),
    ...channelModuleExtensions.map(extension => resolve(base, `index${extension}`)),
  ]
  for (const file of candidates) {
    try {
      return { file, source: readFileSync(file, "utf8") }
    }
    catch {
      continue
    }
  }
}

// Returns [local, exported] pairs for default and named value imports.
function relativeImportBindings(clause: string[]): [string, string][] {
  if (clause[0] === "type" && clause[1] !== ",") return []
  const bindings: [string, string][] = []
  let index = 0
  if (isIdentifier(clause[0] ?? "")) {
    bindings.push([clause[0]!, "default"])
    index = clause[1] === "," ? 2 : 1
  }
  if (clause[index] !== "{") return bindings
  for (let i = index + 1; i < clause.length && clause[i] !== "}"; i++) {
    if (clause[i] === ",") continue
    if (clause[i] === "type" && ![",", "}", "as"].includes(clause[i + 1] ?? "")) {
      while (i < clause.length && ![",", "}"].includes(clause[i + 1] ?? "")) i++
      continue
    }
    const name = exportName(clause[i])
    const local = clause[i + 1] === "as" ? clause[i + 2] : name
    if (clause[i + 1] === "as") i += 2
    if (name !== undefined && local && isIdentifier(local)) bindings.push([local, name])
  }
  return bindings
}

function exportName(token: string | undefined): string | undefined {
  if (!token) return
  if (isIdentifier(token)) return token
  if (!/^["']/.test(token)) return
  if (invalidModuleLiteral(token)) return
  try {
    return moduleSpecifier(token)
  }
  catch {
    return
  }
}

// Returns [exported, imported] pairs for direct relative re-exports.
function relativeExportBindings(clause: string[]): [string, string][] {
  const bindings: [string, string][] = []
  for (let index = 0; index < clause.length; index++) {
    if (clause[index] === ",") continue
    if (clause[index] === "type" && ![",", "}", "as"].includes(clause[index + 1] ?? "")) {
      while (index < clause.length && ![",", "}"].includes(clause[index + 1] ?? "")) index++
      continue
    }
    const name = exportName(clause[index])
    if (name === undefined) continue
    const exported = clause[index + 1] === "as" ? exportName(clause[index + 2]) : name
    if (exported !== undefined) {
      bindings.push([exported, name])
      if (clause[index + 1] === "as") index += 2
    }
  }
  return bindings
}

/** Presets whose Agents need a long-running process host. */
const processHostPresetModules = new Set(["@vite-hub/agent/presets/babysitter", "vite-hub/agent/presets/babysitter"])

/** Whether an Agent module statically imports a preset that needs a process host. */
export function usesProcessHostPreset(source: string): boolean {
  const { tokens } = tokenizeAgentSource(source)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "import" || tokens[index + 1] === "(") continue
    for (let next = index + 1; next < tokens.length && tokens[next] !== ";" && tokens[next] !== "import"; next++) {
      if (!/^['"`]/.test(tokens[next] ?? "")) continue
      if (processHostPresetModules.has(moduleSpecifier(tokens[next]))) return true
      break
    }
  }
  return false
}

/** Discovered Agents whose definitions use a process host preset, by discovered name. */
export function discoverProcessHostAgentNames(definitions: readonly DiscoveredAgentDefinition[]): string[] {
  return definitions.filter(definition => usesProcessHostPreset(readFileSync(definition.handler, "utf8"))).map(definition => definition.name).sort()
}

function isWorkspaceAgentDefinition(source: string, file: string): boolean {
  return inspectAgentModule(source, file, new Set([file])).agentOwnsWorkspace()
}

function inspectAgentModule(source: string, file: string, modules: Set<string>) {
  const { tokens, lineBreaks } = tokenizeAgentSource(source)
  function declarationKeyword(index: number): boolean {
    if (["const", "let", "var"].includes(tokens[index])) return true
    // `using` is contextual; calls and properties with this name are not declarations.
    return tokens[index] === "using" && !lineBreaks.has(index + 1)
      && isIdentifier(tokens[index + 1] ?? "") && ["=", ":", "of"].includes(tokens[index + 2])
  }
  function startsStatement(index: number): boolean {
    if (!lineBreaks.has(index) || !(isIdentifier(tokens[index]) || /^["'0-9]/.test(tokens[index] ?? ""))) return false
    if (["in", "instanceof", "as", "satisfies"].includes(tokens[index])) return false
    const previous = tokens[index - 1]
    return [")", "]", "}"].includes(previous) || /^(?:\d|\.\d|["'`]|\/.)/.test(previous ?? "") ||
      (isIdentifier(previous ?? "") && !["return", "throw", "yield", "await", "new", "typeof", "void", "delete", "in", "instanceof", "as", "satisfies"].includes(previous))
  }
  const declarations = new Map<string, number>()
  const imported = new Set<string>()
  const importedNamespaces = new Set<string>()
  const importedAgentBindings = new Set<string>()
  const importedCapabilityBindings = new Set<string>()
  const importedCapabilityNamespaces = new Set<string>()
  const importedCapabilityFactories = new Map<string, string>()
  const importedChannelBindings = new Set<string>()
  const importedChannelNamespaces = new Set<string>()
  const importedChannelFactories = new Map<string, string>()
  // Static bindings from relative modules, keyed by local name.
  const moduleImports = new Map<string, { specifier: string, name: string }>()
  const moduleNamespaces = new Map<string, string>()
  const namedExports = new Map<string, number>()
  // Bindings re-exported from relative modules, keyed by exported name.
  const reExports = new Map<string, { specifier: string, name: string }>()
  // Specifiers of `export * from` declarations.
  const starExports: string[] = []
  // Local export clauses may appear before their declarations.
  const pendingExports = new Map<string, string>()
  const opaqueExports = new Set<string>()
  const mutatedBindings = new Set<string>()
  const assignedAliases = new Map<string, Set<string>>()
  const loopResultBindings = new Map<number, Set<string>>()
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
            const moduleName = moduleSpecifier(moduleToken)
            if (moduleName === "@vite-hub/agent" || moduleName === "vite-hub/agent") importedNamespaces.add(tokens[j + 1])
            if (moduleName === "@vite-hub/agent/channels" || moduleName === "vite-hub/agent/channels") importedChannelNamespaces.add(tokens[j + 1])
            if (moduleName === "@vite-hub/agent/capabilities" || moduleName === "vite-hub/agent/capabilities") importedCapabilityNamespaces.add(tokens[j + 1])
            continue
          }
          if (!sawFrom && j === i + 1 && /^['"`]/.test(token)) { i = j; break }
          if (sawFrom) {
            if (/^["'`]/.test(token)) {
              const moduleName = moduleSpecifier(token)
              if (moduleName === "@vite-hub/agent" || moduleName === "vite-hub/agent") {
                const bindings = tokens.slice(i + 1, j)
                for (let b = 0; b < bindings.length; b++) {
                  if (bindings[b] === "defineAgent") importedAgentBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                  if (bindings[b] === "defineCapability") importedCapabilityBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                }
              }
              if (moduleName === "@vite-hub/agent/capabilities" || moduleName === "vite-hub/agent/capabilities") {
                const bindings = tokens.slice(i + 1, j)
                for (let b = 0; b < bindings.length; b++) {
                  if (firstPartyCapabilityFactories.has(bindings[b]!) && bindings[b - 1] !== "as") {
                    importedCapabilityFactories.set(bindings[b + 1] === "as" ? bindings[b + 2]! : bindings[b]!, bindings[b]!)
                  }
                }
              }
              if (moduleName === "@vite-hub/agent/channels" || moduleName === "vite-hub/agent/channels") {
                const bindings = tokens.slice(i + 1, j)
                for (let b = 0; b < bindings.length; b++) {
                  if (bindings[b] === "defineChannel") importedChannelBindings.add(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b])
                  if (firstPartyChannelFactories.has(bindings[b]) && bindings[b - 1] !== "as") {
                    importedChannelFactories.set(bindings[b + 1] === "as" ? bindings[b + 2] : bindings[b], bindings[b])
                  }
                }
              }
              if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
                const clause = tokens.slice(i + 1, j - 1)
                for (const [local, name] of relativeImportBindings(clause)) {
                  moduleImports.set(local, { specifier: moduleName, name })
                }
                const star = clause.indexOf("*")
                if (clause[0] !== "type" && star >= 0 && clause[star + 1] === "as" && isIdentifier(clause[star + 2])) {
                  moduleNamespaces.set(clause[star + 2]!, moduleName)
                }
              }
              // Process host presets own no Workspace, so they are known, inspectable parents.
              if (processHostPresetModules.has(moduleName)) for (const binding of tokens.slice(i + 1, j)) imported.delete(binding)
              i = j; break
            }
            continue
          }
          if (isIdentifier(token) && !["from", "as", "type"].includes(token) && tokens[j + 1] !== "as") imported.add(token)
        }
      }
      if (declarationKeyword(i)) {
        // Record every declarator, such as `a` and `b` in `const a = x, b = y`.
        for (const [name, initializer] of declarators(i)) {
          declarations.set(name, initializer)
          if (tokens[i - 1] === "export") namedExports.set(name, initializer)
        }
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
        // Record local export names so an importing Agent can inspect them.
        let close = i + 2
        while (close < tokens.length && tokens[close] !== "}") close++
        if (tokens[close + 1] !== "from") {
          for (let e = i + 2; e < close; e++) {
            if (e !== i + 2 && tokens[e - 1] !== ",") continue
            const local = tokens[e]
            if (!local || !isIdentifier(local)) continue
            const name = tokens[e + 1] === "as" ? exportName(tokens[e + 2]) : local
            if (name !== undefined) pendingExports.set(name, local)
          }
        } else {
          // `export { name as alias } from "./channel"` exports the other
          // module's binding. Package re-exports stay unresolved.
          const specifier = moduleSpecifier(tokens[close + 2])
          if (specifier.startsWith("./") || specifier.startsWith("../")) {
            for (const [alias, name] of relativeExportBindings(tokens.slice(i + 2, close))) {
              reExports.set(alias, { specifier, name })
            }
          }
        }
      }
      if (tokens[i] === "export" && tokens[i + 1] === "*" && tokens[i + 2] === "from") {
        starExports.push(moduleSpecifier(tokens[i + 3]))
      }
      if (tokens[i] === "export" && tokens[i + 1] === "*" && tokens[i + 2] === "as"
        && isIdentifier(tokens[i + 3] ?? "") && tokens[i + 4] === "from") {
        // `export * as name from "./module"` is a namespace binding.
        moduleNamespaces.set(tokens[i + 3]!, moduleSpecifier(tokens[i + 5]))
      }
      if (tokens[i] === "export" && tokens[i + 1] === "function" && isIdentifier(tokens[i + 2] ?? "")) {
        namedExports.set(tokens[i + 2]!, i + 2)
      }
    }
    if (["{", "(", "["].includes(tokens[i])) depth++
    if (["}", ")", "]"].includes(tokens[i])) depth--
  }

  for (const [name, local] of pendingExports) {
    const declaration = declarations.get(local)
    if (declaration !== undefined) {
      if (name === "default") exported = declaration
      else namedExports.set(name, declaration)
      continue
    }
    const moduleImport = moduleImports.get(local)
    if (moduleImport !== undefined) reExports.set(name, moduleImport)
  }

  function assignmentOperator(index: number, sequence = tokens): boolean {
    if (sequence[index] === "=" && (["=", ">"].includes(sequence[index + 1]) || sequence[index - 1] === "=")) return false
    const operators = [
      ["="],
      ["+", "="], ["-", "="], ["*", "="], ["*", "*", "="], ["/", "="], ["%", "="],
      ["&", "="], ["&", "&", "="], ["|", "="], ["|", "|", "="], ["^", "="],
      ["?", "?", "="], ["<", "<", "="], [">", ">", "="], [">", ">", ">", "="],
    ]
    return operators.some(operator => operator.every((token, offset) => sequence[index + offset] === token))
  }

  function assignmentInitializer(index: number): number | undefined {
    if (tokens[index] === "=" && !["=", ">"].includes(tokens[index + 1]!)) return index + 1
    if (["?", "|", "&"].includes(tokens[index]!) && tokens[index + 1] === tokens[index]
      && tokens[index + 2] === "=") return index + 3
  }

  const declaratorInitializers = new Map<number, number>()
  const declarationTypeTokens = new Set<number>()
  for (let keyword = 0; keyword < tokens.length; keyword++) {
    if (!declarationKeyword(keyword)) continue
    for (const [, initializer, binding] of declarators(keyword)) {
      declaratorInitializers.set(binding, initializer)
      for (let index = binding + 1; index < initializer; index++) declarationTypeTokens.add(index)
    }
  }

  function containerAliasTargets(index: number, containerTokens = tokens, inspectReference = false): string[] {
    for (;;) {
      while (containerTokens[index] === "(") index++
      if (containerTokens[index] !== "Object" || containerTokens[index + 1] !== "."
        || containerTokens[index + 2] !== "freeze" || containerTokens[index + 3] !== "(") break
      index += 4
    }
    const opening = containerTokens[index]
    if (opening !== "[" && opening !== "{") {
      if (!inspectReference) return []
      const reference = containerTokens[index]
      if (containerTokens === tokens && isIdentifier(reference ?? "")) {
        return [reference!]
      }
      return containerTokens.slice(index).filter((reference, offset) =>
        isIdentifier(reference) && containerTokens[index + offset - 1] !== ".",
      )
    }
    const closing = opening === "[" ? "]" : "}"
    const targets: string[] = []
    const elements: string[][] = []
    let element: string[] = []
    let depth = 0
    for (let cursor = index + 1; cursor < containerTokens.length; cursor++) {
      const token = containerTokens[cursor]
      if (depth === 0 && token === closing) {
        if (element.length) elements.push(element)
        break
      }
      if (depth === 0 && token === ",") {
        elements.push(element)
        element = []
        continue
      }
      element.push(token)
      if (["{", "[", "("].includes(token)) depth++
      else if (["}", "]", ")"].includes(token)) depth--
    }
    for (let value of elements) {
      if (value.length === 0) continue
      if (value[0] === "." && value[1] === "." && value[2] === ".") value = value.slice(3)
      else if (opening === "{") {
        let separator = -1
        let nesting = 0
        for (let cursor = 0; cursor < value.length; cursor++) {
          const token = value[cursor]
          if (nesting === 0 && token === ":") { separator = cursor; break }
          if (["{", "[", "("].includes(token)) nesting++
          else if (["}", "]", ")"].includes(token)) nesting--
        }
        if (separator !== -1) value = value.slice(separator + 1)
        else if (["get", "set"].includes(value[0]!) && value.includes("{")) {
          // Accessors can return or mutate captured values. Retain their
          // references so writes through the container invalidate them.
          const body = value.indexOf("{")
          targets.push(...containerAliasTargets(0, value.slice(body + 1), true))
          continue
        }
        else if (value.length !== 1) continue
      }
      targets.push(...containerAliasTargets(0, value, true))
    }
    return targets
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

  function callbackBindingNames(start: number, end: number, initializers?: Map<number, number>, sequence = tokens): Set<string> {
    const names = new Set<string>()
    let cursor = start
    if (sequence[cursor] === "async") cursor++
    if (sequence[cursor] === "function") cursor = sequence.indexOf("(", cursor)
    // Method callbacks may point at their body after parameter scanning.
    if (sequence[cursor] === "{" && sequence[cursor - 1] === ")") {
      let depth = 1
      cursor -= 2
      while (cursor >= 0 && depth) {
        if (sequence[cursor] === ")") depth++
        else if (sequence[cursor] === "(") depth--
        if (depth) cursor--
      }
    }
    function skipValue(close: string) {
      let depth = 0
      let type = sequence[cursor] === ":" || sequence[cursor] === "?"
      for (; cursor < end; cursor++) {
        const token = sequence[cursor]
        if (depth === 0 && (token === "," || token === close)) return
        if (depth === 0 && token === "=") type = false
        if (["(", "[", "{"].includes(token) || (type && token === "<")) depth++
        else if ([")", "]", "}"].includes(token) || (type && token === ">" && sequence[cursor - 1] !== "=")) depth--
      }
    }
    function binding() {
      if (sequence[cursor] === "." && sequence[cursor + 1] === "." && sequence[cursor + 2] === ".") cursor += 3
      const token = sequence[cursor]
      if (token === "{" || token === "[") {
        const close = token === "{" ? "}" : "]"
        cursor++
        while (cursor < end && sequence[cursor] !== close) {
          if (sequence[cursor] === ",") { cursor++; continue }
          if (token === "{" && sequence[cursor] === "[") {
            // Computed property expressions do not introduce bindings.
            let depth = 1
            for (cursor++; cursor < end && depth; cursor++) {
              if (sequence[cursor] === "[") depth++
              else if (sequence[cursor] === "]") depth--
            }
            if (sequence[cursor] === ":") cursor++
          } else if (token === "{" && sequence[cursor + 1] === ":") cursor += 2
          binding()
          skipValue(close)
        }
        cursor++
      } else {
        if (isIdentifier(token ?? "")) names.add(token)
        if (sequence[cursor + 1] === "=") initializers?.set(cursor, cursor + 2)
        cursor++
      }
    }
    if (sequence[cursor] !== "(") { binding(); return names }
    cursor++
    while (cursor < end && sequence[cursor] !== ")") {
      if (sequence[cursor] === ",") { cursor++; continue }
      binding()
      skipValue(")")
    }
    return names
  }

  const functionParameterNames = new Map<number, Set<string>>()
  const defaultParameterInitializers = new Map<number, number>()
  for (const body of functionScopes) {
    const arrowBody = tokens[body - 2] === "=" && tokens[body - 1] === ">"
    const parameterEnd = arrowBody ? body - 3 : body - 1
    const parameters = openingDelimiters.get(parameterEnd)
    if (parameters !== undefined) {
      functionParameterNames.set(body, callbackBindingNames(parameters, parameterEnd))
      for (let cursor = parameters + 1; cursor < parameterEnd; cursor++) {
        if (tokens[cursor] === "=" && !["=", ">"].includes(tokens[cursor + 1]!) && tokens[cursor - 1] !== "=") {
          defaultParameterInitializers.set(cursor + 1, parameterEnd)
        }
      }
    }
  }

  const expressionArrowParameters: { start: number; end: number; names: Set<string> }[] = []
  for (let arrow = 0; arrow + 2 < tokens.length; arrow++) {
    if (tokens[arrow] !== "=" || tokens[arrow + 1] !== ">" || tokens[arrow + 2] === "{") continue
    const parameters = openingDelimiters.get(arrow - 1) ?? arrow - 1
    const names = callbackBindingNames(parameters, arrow)
    let end = arrow + 2
    let depth = 0
    for (; end < tokens.length; end++) {
      const token = tokens[end]!
      if (depth === 0 && ([";", ",", ")", "]", "}"].includes(token) || startsStatement(end))) break
      if (["(", "[", "{"].includes(token)) depth++
      else if ([")", "]", "}"].includes(token)) depth--
    }
    expressionArrowParameters.push({ start: arrow + 2, end, names })
  }

  function isFunctionParameter(index: number, name = tokens[index]): boolean {
    for (let scope = tokenScopes[index]; scope !== undefined; scope = scopeParents.get(scope)) {
      if (functionParameterNames.get(scope)?.has(name)) return true
    }
    return false
  }

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "catch" || tokens[index + 1] !== "(") continue
    const close = [...openingDelimiters].find(([, opening]) => opening === index + 1)?.[0]
    if (close === undefined) continue
    const body = close + 1
    const end = [...openingDelimiters].find(([, opening]) => opening === body)?.[0]
    if (end !== undefined && tokens[body] === "{") {
      callbackParameters.push({ start: body, end, names: callbackBindingNames(index + 1, close) })
    }
  }

  function patternOpening(close: number): number | undefined {
    let depth = 0
    for (let index = close; index >= 0; index--) {
      if (["]", "}"].includes(tokens[index]!)) depth++
      else if (["[", "{"].includes(tokens[index]!)) {
        depth--
        if (depth === 0) return index
      }
    }
  }

  function invalidatePatternExpression(start: number, end: number) {
    for (let index = start; index < end; index++) {
      if (!declarations.has(tokens[index]!) || ![".", "["].includes(tokens[index + 1]!)) continue
      const memberEnd = memberCallEnd(index)
      const update = ["+", "-"].includes(tokens[memberEnd] ?? "") && tokens[memberEnd + 1] === tokens[memberEnd]
      const prefixUpdate = ["+", "-"].includes(tokens[index - 2] ?? "") && tokens[index - 1] === tokens[index - 2]
      const deletion = tokens[index - 1] === "delete"
      if ((assignmentOperator(memberEnd) || update || prefixUpdate || deletion) && memberEnd <= end) mutatedBindings.add(tokens[index]!)
    }
  }

  function recordDestructuringAliases(pattern: number, end: number, value: number, failClosed = true) {
    for (let index = pattern + 1; index < end; index++) {
      const close = tokens[index] === "[" ? [...openingDelimiters].find(([, opening]) => opening === index)?.[0] : undefined
      if (close !== undefined && tokens[close + 1] === ":") {
        invalidatePatternExpression(index + 1, close)
        index = close
        continue
      }
      if (tokens[index] === "=") {
        let depth = 0
        const expressionStart = index + 1
        for (index++; index < end; index++) {
          if (depth === 0 && [",", "]", "}"].includes(tokens[index]!)) break
          if (["(", "[", "{"].includes(tokens[index]!)) depth++
          else if ([")", "]", "}"].includes(tokens[index]!)) depth--
        }
        invalidatePatternExpression(expressionStart, index)
        index--
        continue
      }
      if (declarations.has(tokens[index]!) && [".", "["].includes(tokens[index + 1]!)) {
        mutatedBindings.add(tokens[index]!)
        index = memberCallEnd(index) - 1
      }
    }
    const names = [...callbackBindingNames(pattern, end)]
    const targets = containerAliasTargets(value, tokens, true)
    let source = value
    while (tokens[source] === "(" || tokens[source] === "await") source++
    // An identifier-backed iterable or getter may return captured values that
    // cannot be recovered by tracing the container's literal members.
    if (isIdentifier(tokens[source] ?? "") && !importedChannelNamespaces.has(tokens[source]!)) {
      for (const name of names) opaqueDestructuredBindings.add(name)
    }
    if (names.length !== targets.length) {
      if (!failClosed) return
      for (const name of names) mutatedBindings.add(name)
      return
    }
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!
      const target = targets[index]
      if (target === undefined) continue
      const aliases = assignedAliases.get(name) ?? new Set<string>()
      aliases.add(target)
      assignedAliases.set(name, aliases)
    }
  }

  const destructuredBindings = new Map<number, Set<string>>()
  const opaqueDestructuredBindings = new Set<string>()
  const destructuredChannelHelpers = new Map<number, Map<string, { reference: number, helper: string }>>()
  const destructuredImportedHelpers = new Map<number, Map<string, number>>()
  const variableDeclarations = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    if (!declarationKeyword(i)) continue
    variableDeclarations.set(i, i)
    const scope = tokenScopes[i]
    for (let cursor = i + 1; cursor < tokens.length; cursor++) {
      if (tokenScopes[cursor] !== scope) continue
      if (declarationKeyword(cursor) || [";", "export", "return", "in", "of", "}", ")"].includes(tokens[cursor])) break
      if (tokens[cursor] === "," && (["[", "{"].includes(tokens[cursor + 1])
        || (isIdentifier(tokens[cursor + 1] ?? "") && ["=", ":", "!"].includes(tokens[cursor + 2])))) {
        variableDeclarations.set(cursor, i)
      }
    }
  }
  for (const binding of variableDeclarations.keys()) {
    if (["[", "{"].includes(tokens[binding + 1])) {
      const names = callbackBindingNames(binding + 1, tokens.length, declaratorInitializers)
      destructuredBindings.set(binding, names)
      let cursor = binding + 1
      let nesting = 0
      do {
        if (["[", "{"].includes(tokens[cursor])) nesting++
        else if (["]", "}"].includes(tokens[cursor])) nesting--
        cursor++
      } while (cursor < tokens.length && nesting > 0)
      if (["=", "of"].includes(tokens[cursor])) recordDestructuringAliases(binding + 1, cursor, cursor + 1, false)
      if (tokens[binding + 1] === "{" && tokens[cursor] === "=" && importedChannelNamespaces.has(tokens[cursor + 1]!)
        && ([";", ",", undefined].includes(tokens[cursor + 2]) || startsStatement(cursor + 2))) {
        const helpers = new Map<string, { reference: number, helper: string }>()
        for (let property = binding + 2; property < cursor - 1; property++) {
          if (tokenScopes[property] !== binding + 1 || !["{", ","].includes(tokens[property - 1]!)
            || !firstPartyChannelFactories.has(tokens[property]!)) continue
          const name = tokens[property + 1] === ":" ? tokens[property + 2] : tokens[property]
          const end = tokens[property + 1] === ":" ? property + 3 : property + 1
          // A trusted namespace always supplies this helper, so its default never runs.
          if (name && names.has(name) && [",", "}", "="].includes(tokens[end]!)) helpers.set(name, { reference: cursor + 1, helper: tokens[property]! })
        }
        destructuredChannelHelpers.set(binding, helpers)
      }
      if (tokens[binding + 1] === "[" && tokens[cursor] === "=" && tokens[cursor + 1] === "[") {
        const references = new Map<string, number>()
        let value = cursor + 2
        for (let name = binding + 2; name < cursor - 1; name += 2, value += 2) {
          if (![",", "]"].includes(tokens[name + 1]!) || ![",", "]"].includes(tokens[value + 1]!)) break
          if (importedChannelFactories.has(tokens[value]!) && names.has(tokens[name]!)) references.set(tokens[name]!, value)
        }
        destructuredImportedHelpers.set(binding, references)
      }
      for (let index = binding + 2; index < cursor; index++) {
        if (tokens[index] !== "=" || ["=", ">"].includes(tokens[index + 1]) || tokens[index - 1] === "=") continue
        const targets = containerAliasTargets(0, tokens.slice(index + 1, cursor), true)
        if (targets.length === 0) continue
        const name = [...names].find(candidate => tokens.slice(binding + 1, index).includes(candidate))
        if (name === undefined) continue
        const aliases = assignedAliases.get(name) ?? new Set<string>()
        for (const target of targets) aliases.add(target)
        assignedAliases.set(name, aliases)
      }
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (declarationTypeTokens.has(i)) continue
    if (tokens[i - 1] === "." && tokens[i - 2] !== ".") continue
    const name = tokens[i]
    if (!declarations.has(name) && !isIdentifier(name ?? "")) continue
    const memberEnd = memberCallEnd(i)
    const propertyAssignment = memberEnd > i + 1 && assignmentOperator(memberEnd)
    const directAssignment = assignmentOperator(i + 1) && !declaratorInitializers.has(i)
    const prefixUpdate = ["+", "-"].includes(tokens[i - 2] ?? "") && tokens[i - 1] === tokens[i - 2]
    const postfixUpdate = ["+", "-"].includes(tokens[memberEnd] ?? "") && tokens[memberEnd + 1] === tokens[memberEnd]
    let deletion = tokens[i - 1] === "delete"
    for (let cursor = i - 1; !deletion && tokens[cursor] === "("; cursor--) {
      deletion = tokens[cursor - 1] === "delete"
    }
    // Global member writes must invalidate Object before the generic mutation
    // scan marks globalThis itself as mutated.
    if (globalBindingReference(i, "globalThis")) {
      const objectMember = memberAccess(i)
      const freezeMember = objectMember?.name === "Object" ? memberAccess(objectMember.end - 1) : undefined
      if (freezeMember?.name === "freeze" && assignmentOperator(freezeMember.end)) mutatedBindings.add("Object")
    }
    if ((propertyAssignment || directAssignment || prefixUpdate || postfixUpdate || deletion)
      && !isFunctionParameter(i)) mutatedBindings.add(name)

    let assignmentEnd = i + 1
    for (let opening = i - 1; tokens[opening] === "(" && openingDelimiters.get(assignmentEnd) === opening; opening--) assignmentEnd++
    const initializer = declaratorInitializers.get(i) ?? assignmentInitializer(assignmentEnd)
    if (initializer !== undefined) {
      const targets = containerAliasTargets(initializer)
      const aliases = assignedAliases.get(name) ?? new Set<string>()
      for (const target of targets) aliases.add(target)
      if (aliases.size) assignedAliases.set(name, aliases)
    }
    if (initializer !== undefined) {
      let aliasInitializer = initializer
      while (tokens[aliasInitializer] === "(") aliasInitializer++
      let aliasEnd = aliasInitializer
      let nesting = 0
      while (aliasEnd < tokens.length) {
        const token = tokens[aliasEnd]
        if (nesting === 0 && ([";", ","].includes(token!) || startsStatement(aliasEnd))) break
        if (["(", "[", "{"].includes(token!)) nesting++
        else if ([")", "]", "}"].includes(token!)) {
          if (nesting === 0) break
          nesting--
        }
        aliasEnd++
      }
      if (["?", "||", "&&", "??"].some(operator => tokens.slice(aliasInitializer, aliasEnd).includes(operator))) {
        const aliases = assignedAliases.get(name) ?? new Set<string>()
        const possibleTargets = tokens.slice(aliasInitializer, aliasEnd).flatMap((token, offset) =>
          isIdentifier(token) && tokens[aliasInitializer + offset - 1] !== "." ? [token] : [])
        for (const target of possibleTargets) {
          aliases.add(target)
        }
        if (aliases.size) assignedAliases.set(name, aliases)
      }
    }
    if (initializer !== undefined) {
      let aliasReference = initializer
      while (tokens[aliasReference] === "(") aliasReference++
      if (isIdentifier(tokens[aliasReference] ?? "")) {
        let aliasEnd = aliasReference + 1
        while (tokens[aliasEnd] === "." || tokens[aliasEnd] === "[") {
          if (tokens[aliasEnd] === ".") {
            if (!isIdentifier(tokens[aliasEnd + 1] ?? "")) break
            aliasEnd += 2
          }
          else {
            let nesting = 1
            aliasEnd++
            while (aliasEnd < tokens.length && nesting > 0) {
              if (tokens[aliasEnd] === "[") nesting++
              if (tokens[aliasEnd] === "]") nesting--
              aliasEnd++
            }
            if (nesting > 0) break
          }
        }
        while (tokens[aliasEnd] === "!" || tokens[aliasEnd] === "as" || tokens[aliasEnd] === "satisfies") {
          aliasEnd = tokens[aliasEnd] === "!" ? aliasEnd + 1 : skipAssertion(aliasEnd)
        }
        while (tokens[aliasEnd] === ")") aliasEnd++
        if ([";", ",", undefined].includes(tokens[aliasEnd])) {
          const targets = assignedAliases.get(name) ?? new Set<string>()
          targets.add(tokens[aliasReference]!)
          assignedAliases.set(name, targets)
        }
      }
    }
  }
  for (const [close, opening] of openingDelimiters) {
    if (tokens[opening] === "(") {
      const compound = tokens.slice(opening + 1, close).some((token, offset) =>
        tokenScopes[opening + 1 + offset] === opening && ["?", "&", "|", ","].includes(token),
      )
      const memberEnd = memberCallEnd(close, opening)
      const update = ["+", "-"].includes(tokens[memberEnd] ?? "") && tokens[memberEnd + 1] === tokens[memberEnd]
      let receiver = opening
      while (tokens[receiver - 1] === "(") receiver--
      const prefixUpdate = ["+", "-"].includes(tokens[receiver - 2] ?? "") && tokens[receiver - 1] === tokens[receiver - 2]
      if (compound && memberEnd > close + 1 && (assignmentOperator(memberEnd) || update || prefixUpdate || tokens[memberEnd] === "(" || tokens[receiver - 1] === "delete")) {
        for (let reference = opening + 1; reference < close; reference++) {
          if (visibleDeclaration(reference) !== undefined && !isFunctionParameter(reference)) mutatedBindings.add(tokens[reference]!)
        }
      }
      continue
    }
    if (!["[", "{"].includes(tokens[opening]) || declarationTypeTokens.has(opening)) continue
    const memberEnd = memberCallEnd(close, opening)
    if (memberEnd <= close + 1) continue
    let member = close + 1
    while ([")", "!", "as", "satisfies"].includes(tokens[member])) {
      member = ["as", "satisfies"].includes(tokens[member]) ? skipAssertion(member) : member + 1
    }
    if (tokens[member] === "?" && tokens[member + 1] === ".") member += tokens[member + 2] === "[" ? 2 : 1
    let valueEnd = member
    let targets = containerAliasTargets(opening)
    if (tokens[member] === ".") {
      if (tokens[opening] === "[") continue
      const property = member + 1
      const value = properties(opening).get(tokens[property])
      if (value === undefined) {
        const accessor = tokens.findIndex((token, cursor) => cursor > opening && cursor < close
          && tokenScopes[cursor] === opening && ["get", "set"].includes(token)
          && (tokens[cursor + 1] === "[" || propertyName(tokens[cursor + 1] ?? "") === tokens[property]))
        if (accessor === -1) {
          // An assignment to a previously absent property can alias a local
          // options object. Invalidate RHS bindings so stale literals are not
          // inspected after `holder.options = options`.
          if (assignmentOperator(memberEnd)) {
            for (const target of containerAliasTargets(memberEnd + 1)) mutatedBindings.add(target)
          }
          continue
        }
        // Computed accessors can select any captured value. Invalidate all
        // references in the container rather than guessing the selected body.
      }
      else targets = containerAliasTargets(value, tokens, true)
      valueEnd = property + 1
    }
    else if (tokens[member] === "[") {
      let nesting = 1
      for (valueEnd++; valueEnd < tokens.length && nesting > 0; valueEnd++) {
        if (tokens[valueEnd] === "[") nesting++
        else if (tokens[valueEnd] === "]") nesting--
      }
      if (valueEnd === member + 3) {
        const token = tokens[resolveReference(member + 1)]
        const key = token === undefined ? undefined : /^["'`]/.test(token) ? propertyName(token) : token
        if (tokens[opening] === "[" && /^\d+$/.test(key ?? "")) {
          let start = opening + 1
          let position = 0
          for (let cursor = start; cursor <= close; cursor++) {
            if (cursor !== close && (tokens[cursor] !== "," || tokenScopes[cursor] !== opening)) continue
            if (tokens[start] === "." && tokens[start + 1] === "." && tokens[start + 2] === ".") break
            if (position === Number(key)) {
              targets = containerAliasTargets(0, tokens.slice(start, cursor), true)
              break
            }
            start = cursor + 1
            position++
          }
        }
        else if (tokens[opening] === "{" && /^["'`]/.test(token ?? "")) {
          const value = properties(opening).get(key!)
          targets = value === undefined ? [] : containerAliasTargets(value, tokens, true)
        }
      }
    }
    else continue
    const assignment = assignmentOperator(memberEnd)
    const postfixUpdate = ["+", "-"].includes(tokens[memberEnd] ?? "") && tokens[memberEnd + 1] === tokens[memberEnd]
    let receiver = opening
    while (tokens[receiver - 1] === "(") receiver--
    const prefixUpdate = ["+", "-"].includes(tokens[receiver - 2] ?? "") && tokens[receiver - 1] === tokens[receiver - 2]
    const deletion = tokens[receiver - 1] === "delete"
    if (!assignment && !postfixUpdate && !prefixUpdate && !deletion && tokens[memberEnd] !== "(") continue
    if (tokens[memberEnd] !== "(" && memberEnd <= valueEnd) continue
    const referenced = new Set(targets)
    for (let reference = opening + 1; reference < close; reference++) {
      if (referenced.has(tokens[reference]) && tokens[reference - 1] !== "."
        && (visibleDeclaration(reference) !== undefined || imported.has(tokens[reference])) && !isFunctionParameter(reference)) {
        mutatedBindings.add(tokens[reference])
      }
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "=" && ["]", "}"].includes(tokens[index - 1] ?? "")) {
      const pattern = patternOpening(index - 1)
      if (pattern !== undefined && [undefined, "(", ")", ";", "{", "}", "="].includes(tokens[pattern - 1])) {
        recordDestructuringAliases(pattern, index, index + 1)
      }
      continue
    }
    if (!["of", "in"].includes(tokens[index]!)) continue
    // Member expressions are also assignment targets in `for...in/of`.
    // Invalidate their local base binding before inspecting Channel options.
    let member = index - 1
    while (member >= 0) {
      if (tokens[member] === "]") {
        const opening = openingDelimiters.get(member)
        if (opening === undefined) break
        member = opening - 1
      }
      else if (member >= 2 && tokens[member - 1] === ".") {
        member -= 2
      }
      else break
    }
    const loopHeader = tokens[member - 1] === "(" && (tokens[member - 2] === "for"
      || (tokens[member - 2] === "await" && tokens[member - 3] === "for"))
    if (member >= 0 && isIdentifier(tokens[member]) && loopHeader
      && declarations.has(tokens[member]!)) {
      mutatedBindings.add(tokens[member]!)
      continue
    }
    if (isIdentifier(tokens[index - 1] ?? "")) {
      const alias = tokens[index - 1]!
      // A binding declared outside the loop is assigned by the `of` target.
      // Invalidate it even though the declaration keyword is before `for`.
      if (declarations.has(alias) && tokens[index - 2] === "(" && tokens[index - 3] === "for") {
        mutatedBindings.add(alias)
        continue
      }
      let declaration = index - 2
      while (declaration >= 0 && !declarationKeyword(declaration) && tokens[declaration] !== "for") declaration--
      // A predeclared `for...of` target is assigned on every iteration. Its
      // initialiser cannot safely be used for Channel ownership inference.
      if (!declarationKeyword(declaration)) continue
      const loopDeclaration = tokens[declaration - 1] === "(" && (tokens[declaration - 2] === "for"
        || (tokens[declaration - 2] === "await" && tokens[declaration - 3] === "for"))
      if (!loopDeclaration) mutatedBindings.add(alias)
      const targets = containerAliasTargets(index + 1, tokens, true)
      if (targets.length) {
        const aliases = assignedAliases.get(alias) ?? new Set<string>()
        for (const target of targets) aliases.add(target)
        assignedAliases.set(alias, aliases)
      }
      continue
    }
    if (!["]", "}"].includes(tokens[index - 1] ?? "")) continue
    const pattern = patternOpening(index - 1)
    if (pattern === undefined) continue
    recordDestructuringAliases(pattern, index, index + 1)
    loopResultBindings.set(index + 1, callbackBindingNames(pattern, index))
  }
  // A property assignment can introduce an alias into a container that had
  // no literal property to inspect. Invalidate local RHS references so a
  // later mutation through that property cannot use a stale initializer.
  for (let index = 0; index + 4 < tokens.length; index++) {
    if (declarationTypeTokens.has(index) || declarationKeyword(index)) continue
    if (!isIdentifier(tokens[index]) && ![")", "]", "}"].includes(tokens[index]!)) continue
    if (![".", "["].includes(tokens[index + 1]!)) continue
    let assignment = memberCallEnd(index)
    if (!assignmentOperator(assignment)) continue
    while (tokens[assignment] !== "=") assignment++
    let depth = 0
    for (let reference = assignment + 1; reference < tokens.length; reference++) {
      const token = tokens[reference]!
      if (depth === 0 && ([";", ",", ")", "]", "}"].includes(token) || startsStatement(reference))) break
      if (token === "<" && (reference === assignment + 1 || tokens[reference - 1] === "(")) {
        reference = skipTypeArguments(reference) - 1
        continue
      }
      if (["(", "[", "{"].includes(token)) depth++
      else if ([")", "]", "}"].includes(token)) depth--
      if (visibleDeclaration(reference) !== undefined && tokens[reference - 1] !== ".") mutatedBindings.add(token)
    }
  }
  // A reassigned global freeze helper cannot be trusted for static inspection.
  // Record direct, computed, Object.assign, Reflect.set, and property descriptor writes before recognizing any
  // Object.freeze call as value-preserving.
  for (let index = 0; index < tokens.length; index++) {
    const objectEnd = intrinsicObjectEnd(index)
    const receiverEnd = objectEnd ?? intrinsicReflectEnd(index)
    if (receiverEnd === undefined) continue
    const member = memberAccess(receiverEnd - 1)
    if (objectEnd !== undefined && member?.name === "freeze" && assignmentOperator(member.end)) mutatedBindings.add("Object")
    const call = member === undefined ? undefined : memberCallEnd(member.end - 1, index)
    if (objectEnd !== undefined && member?.name === "assign" && call !== undefined && tokens[call] === "(") {
      const target = resolveReference(call + 1, new Set(), true)
      const targetEnd = intrinsicObjectEnd(target)
      if (targetEnd !== undefined && tokens[targetEnd] === ",") mutatedBindings.add("Object")
    }
    if ((member?.name === "defineProperty" || (objectEnd !== undefined && member?.name === "defineProperties") || (objectEnd === undefined && member?.name === "set")) && call !== undefined && tokens[call] === "(") {
      const target = resolveReference(call + 1, new Set(), true)
      const targetEnd = intrinsicObjectEnd(target)
      if (targetEnd === undefined || tokens[targetEnd] !== ",") continue
      // Descriptor maps may be opaque or contain computed freeze properties.
      const property = resolveReference(targetEnd + 1)
      if (member.name === "defineProperties" || propertyName(tokens[property] ?? "") === "freeze") mutatedBindings.add("Object")
    }
  }
  const opaqueCalls = new Set<number>()
  const trustedCalls = new Set<number>()
  const directEvalCalls = new Set<number>()
  const parameterLists = new Set([...functionScopes].map(scope => openingDelimiters.get(scope - 1)))
  const factories = ["defineAgent", "defineChannel", "defineCapability", "channelHelper"] as const
  for (let index = 0; index < tokens.length; index++) {
    if ((tokens[index] === "(" || tokens[index]?.startsWith("`"))
      && ([")", "]"].includes(tokens[index - 1]) || tokens[index - 1]?.startsWith("`"))) opaqueCalls.add(index)
    if (!isIdentifier(tokens[index]) || tokens[index - 1] === "function") continue
    const call = memberCallEnd(index)
    const tagged = tokens[call]?.startsWith("`")
    if ((tokens[call] !== "(" && !tagged) || ["if", "for", "while", "switch", "catch", "with", "default", "return", "throw", "yield", "await", "new", "typeof", "void", "delete", "function"].includes(tokens[index])) continue
    opaqueCalls.add(call)
    if (!tagged && tokens[index] === "eval" && tokens[index - 1] !== ".") directEvalCalls.add(call)
    if (call > index + 1 && visibleDeclaration(index) !== undefined) mutatedBindings.add(tokens[index])
    if (!tagged && globalObjectReference(index) && tokens[index + 1] === "." && tokens[index + 2] === "freeze") trustedCalls.add(call)
    if (tokens[index - 1] !== "." && factories.some(name => factoryCall(index, name) === call)) trustedCalls.add(call)
  }
  const opaqueResultBindings = new Set<string>(opaqueDestructuredBindings)
  for (let binding = 0; binding < tokens.length; binding++) {
    if (tokens[binding - 1] === "." || (!destructuredBindings.has(binding) && visibleDeclaration(binding) === undefined)) continue
    let initializer = declaratorInitializers.get(binding)
      ?? assignmentInitializer(binding + 1)
    if (initializer === undefined && destructuredBindings.has(binding)) {
      let cursor = binding + 1
      let nesting = 0
      do {
        if (["[", "{"].includes(tokens[cursor]!)) nesting++
        else if (["]", "}"].includes(tokens[cursor]!)) nesting--
        cursor++
      } while (cursor < tokens.length && nesting > 0)
      if (["=", "of"].includes(tokens[cursor]!)) initializer = cursor + 1
    }
    if (initializer === undefined) continue
    while (tokens[initializer] === "(" || tokens[initializer] === "await") initializer++
    const call = memberCallEnd(initializer)
    if (opaqueCalls.has(call) && !trustedCalls.has(call)) {
      for (const name of destructuredBindings.get(binding) ?? [tokens[binding]!]) opaqueResultBindings.add(name)
    }
  }
  // Predeclared loop targets have no destructuring declaration to record
  // an opaque result. Keep their writes subject to captured-binding taint.
  for (const [initializer, names] of loopResultBindings) {
    let value = initializer
    while (tokens[value] === "(" || tokens[value] === "await") value++
    const call = memberCallEnd(value)
    if (opaqueCalls.has(call) && !trustedCalls.has(call)) {
      for (const name of names) opaqueResultBindings.add(name)
    }
  }
  function invalidateCapturedBindings() {
    for (const name of declarations.keys()) mutatedBindings.add(name)
    for (const binding of variableDeclarations.keys()) {
      for (const name of destructuredBindings.get(binding) ?? [tokens[binding + 1]!]) mutatedBindings.add(name)
    }
  }
  // Direct eval executes in this module's lexical scope and can mutate any
  // captured Channel options without leaving a statically visible write.
  if (directEvalCalls.size > 0) invalidateCapturedBindings()
  // Template interpolations execute expressions hidden inside a literal token.
  // Track referenced captures and keep opaque calls conservative.
  for (let templateIndex = 0; templateIndex < tokens.length; templateIndex++) {
    const template = tokens[templateIndex]!
    if (!template.startsWith("`") || !/(?<!\\)(?:\\\\)*\$\{/.test(template)) continue
    const referenceLineBreaks = new Set<number>()
    const references = templateReferences(template, referenceLineBreaks)
    // Template locals shadow names only within their own scope.
    const templateLocalBindings: { start: number; end: number; names: Set<string> }[] = []
    const referenceOpenings = new Map<number, number>()
    const referenceStack: number[] = []
    for (let index = 0; index < references.length; index++) {
      if (["(", "[", "{"].includes(references[index]!)) referenceStack.push(index)
      else if ([")", "]", "}"].includes(references[index]!)) {
        const opening = referenceStack.pop()
        if (opening !== undefined) referenceOpenings.set(index, opening)
      }
    }
    const referenceClosings = new Map([...referenceOpenings].map(([closing, opening]) => [opening, closing]))
    for (let arrow = 0; arrow < references.length; arrow++) {
      if (references[arrow] !== "=" || references[arrow + 1] !== ">") continue
      const start = referenceOpenings.get(arrow - 1) ?? arrow - 1
      const names = new Set(references.slice(start, arrow).filter(isIdentifier))
      let end = arrow + 2
      let depth = 0
      for (; end < references.length; end++) {
        const token = references[end]!
        // An unparenthesized arrow in a conditional only owns the consequent.
        // Stop before the alternate branch so its references are not treated
        // as parameters of the arrow.
        if (depth === 0 && [";", ",", ":", ")", "]", "}"].includes(token)) break
        if (["(", "[", "{"].includes(token)) depth++
        else if ([")", "]", "}"].includes(token)) depth--
      }
      templateLocalBindings.push({ start, end, names })
    }
    const methodKey = (index: number) => {
      if (["if", "for", "while", "switch", "catch", "with"].includes(references[index] ?? "")) return false
      if (references[index + 1] !== "(") return false
      const closing = referenceClosings.get(index + 1)
      if (closing === undefined || references[closing + 1] !== "{") return false
      const previous = references[index - 1]
      if (["{", ",", ";", "}"].includes(previous ?? "")) return true
      return ["get", "set", "async", "*"].includes(previous ?? "")
        && ["{", ",", ";", "}", "async"].includes(references[index - 2] ?? "")
        || previous === "static"
        || ["get", "set", "async", "*"].includes(previous ?? "")
          && references[index - 2] === "static"
        || previous === "*" && references[index - 2] === "async"
    }
    // Function expressions create a local name and parameter scope. Their
    // declaration syntax also contains a parenthesized token sequence that
    // must not be mistaken for an opaque call.
    const functionExpression = (index: number) => {
      if (references[index] !== "function") return undefined
      let cursor = index + 1
      if (references[cursor] === "*") cursor++
      const name = isIdentifier(references[cursor] ?? "") ? references[cursor++] : undefined
      if (references[cursor] !== "(") return undefined
      const close = referenceClosings.get(cursor)
      if (close === undefined || references[close + 1] !== "{") return undefined
      const bodyClose = referenceClosings.get(close + 1)
      if (bodyClose === undefined) return undefined
      return { name, parameters: cursor, parameterClose: close, bodyOpen: close + 1, bodyClose }
    }
    const uncalledFunctionBodies: { start: number; end: number }[] = []
    // An arrow expression created inside an interpolation is not invoked by
    // evaluating the template. Ignore calls in its body, just like function
    // expressions, while retaining immediately invoked arrows.
    for (let arrow = 0; arrow + 1 < references.length; arrow++) {
      if (references[arrow] !== "=" || references[arrow + 1] !== ">") continue
      const start = arrow + 2
      let end = start
      if (references[start] === "{") {
        end = referenceClosings.get(start) ?? start
      } else {
        let depth = 0
        for (; end < references.length; end++) {
          const token = references[end]!
          if (depth === 0 && ([";", ",", ")", "]", "}"].includes(token) || referenceLineBreaks.has(end))) break
          if (["(", "[", "{"].includes(token)) depth++
          else if ([")", "]", "}"].includes(token)) depth--
        }
        end--
      }
      // An immediately invoked arrow wrapped in parentheses is followed by
      // the grouping closers before its call, for example `(() => value)()`.
      // Skip those closers when deciding whether the body executes.
      // Consume the single grouping delimiter that wraps an immediately
      // invoked arrow. Do not skip delimiters belonging to an enclosing call:
      // `consume(() => value)()` invokes `consume`, not the callback arrow.
      let invocation = end + 1
      if ([")", "]", "}"].includes(references[invocation] ?? "")) {
        // A closing delimiter can belong to the argument list of an
        // enclosing call. In `consume(() => value)()`, the following call
        // invokes consume's result, not the callback arrow. Parenthesized
        // IIFEs have no callee immediately before their grouping delimiter.
        const groupingOpen = referenceOpenings.get(invocation)
        const groupingCallee = groupingOpen === undefined ? undefined : references[groupingOpen - 1]
        if (groupingCallee === undefined || !isIdentifier(groupingCallee)) invocation++
      }
      if (end >= start && references[invocation] !== "(") uncalledFunctionBodies.push({ start, end })
    }
    const functionExpressionCall = (index: number) => {
      for (let cursor = Math.max(0, index - 3); cursor <= index; cursor++) {
        const expression = functionExpression(cursor)
        if (expression && expression.parameters === index + 1) return true
      }
      return false
    }
    for (let index = 0; index < references.length; index++) {
      const expression = functionExpression(index)
      if (expression === undefined) continue
      const names = callbackBindingNames(expression.parameters, expression.parameterClose, undefined, references)
      if (expression.name !== undefined) names.add(expression.name)
      templateLocalBindings.push({ start: index, end: expression.bodyClose, names })
      // Constructing a function only stringifies its source. Calls in an
      // uninvoked function body cannot execute while evaluating the template.
      // Keep immediately invoked function expressions conservative.
      const afterBody = references[expression.bodyClose + 1]
      if (!['(', '.', '?.'].includes(afterBody ?? '')) {
        uncalledFunctionBodies.push({ start: expression.bodyOpen, end: expression.bodyClose })
      }
    }
    // Method parameters shadow module bindings throughout their method body.
    // Keep these names local to the template interpolation so an unrelated
    // method such as `render(portal) { return portal.id }` cannot taint an
    // imported `portal` binding.
    for (let index = 0; index < references.length; index++) {
      if (!methodKey(index)) continue
      const parameterOpen = index + 1
      const parameterClose = referenceClosings.get(parameterOpen)
      if (parameterClose === undefined || references[parameterClose + 1] !== "{") continue
      const bodyOpen = parameterClose + 1
      const bodyClose = referenceClosings.get(bodyOpen)
      if (bodyClose === undefined) continue
      const names = callbackBindingNames(parameterOpen, parameterClose, undefined, references)
      templateLocalBindings.push({ start: parameterOpen, end: bodyClose, names })
    }
    // Class static blocks have their own lexical scope. Track the block so
    // declarations inside it cannot be mistaken for imported captures.
    for (let index = 0; index < references.length; index++) {
      if (references[index] !== "static" || references[index + 1] !== "{") continue
      const end = referenceClosings.get(index + 1)
      if (end !== undefined) templateLocalBindings.push({ start: index, end, names: new Set() })
    }
    // Resolve body declarations in their lexical block, or function for var.
    // Do not let a method local hide imported reads in another interpolation.
    const templateFunctionScopes = [...templateLocalBindings]
    for (let index = 0; index < references.length; index++) {
      if (references[index] !== "catch" || references[index + 1] !== "(") continue
      const close = referenceClosings.get(index + 1)
      if (close === undefined || references[close + 1] !== "{") continue
      const end = referenceClosings.get(close + 1)
      if (end !== undefined) {
        const names = callbackBindingNames(index + 1, close, undefined, references)
        templateLocalBindings.push({ start: index + 1, end, names })
      }
    }
    const templateStatementEnd = (start: number): number => {
      const token = references[start]
      if (token === "{") return (referenceClosings.get(start) ?? start) + 1
      if (["for", "if", "while", "with", "switch"].includes(token ?? "")) {
        const parameters = token === "for" && references[start + 1] === "await" ? start + 2 : start + 1
        const close = referenceClosings.get(parameters)
        if (close !== undefined) {
          const end = templateStatementEnd(close + 1)
          return token === "if" && references[end] === "else" ? templateStatementEnd(end + 1) : end
        }
      }
      for (let cursor = start; cursor < references.length; cursor++) {
        if (["}", ")", "]"].includes(references[cursor]!)) return cursor
        if (references[cursor] === ";") return cursor + 1
        if (cursor > start && referenceLineBreaks.has(cursor)
          && endsAgentExpression(references.slice(start, cursor))) return cursor
        cursor = referenceClosings.get(cursor) ?? cursor
      }
      return references.length
    }
    for (let index = 0; index < references.length; index++) {
      const keyword = references[index]!
      const declarationStart = keyword === "function" && references[index - 1] === "async" ? index - 1 : index
      const loopOpen = references[index - 1] === "(" && (references[index - 2] === "for"
        || references[index - 2] === "await" && references[index - 3] === "for") ? index - 1 : undefined
      if (!["const", "let", "var", "function", "class"].includes(keyword)
        || loopOpen === undefined && !["{", ";", "}"].includes(references[declarationStart - 1] ?? "") && !referenceLineBreaks.has(declarationStart)) continue
      const owner = templateFunctionScopes.filter(scope => index > scope.start && index < scope.end)
        .sort((a, b) => b.start - a.start)[0]
      if (!owner) continue
      const block = [...referenceClosings].filter(([opening, closing]) =>
        references[opening] === "{" && opening < index && closing > index)
        .sort(([a], [b]) => b - a)[0]
      if (!block) continue
      const loopClose = loopOpen === undefined ? undefined : referenceClosings.get(loopOpen)
      const start = keyword === "var" ? owner.start : loopOpen ?? block[0]
      const end = keyword === "var" ? owner.end : loopClose === undefined ? block[1] : templateStatementEnd(loopClose + 1)
      // Statement declarations bind their name throughout the containing
      // block. A named expression instead binds only inside its own body.
      if (keyword === "function" || keyword === "class") {
        const name = keyword === "function" ? functionExpression(index)?.name : references[index + 1]
        if (name !== undefined && isIdentifier(name)) templateLocalBindings.push({ start, end, names: new Set([name]) })
        continue
      }
      const names = new Set<string>()
      let binding = index + 1
      while (binding < end) {
        for (const name of callbackBindingNames(binding, end, undefined, references)) names.add(name)
        let cursor = (referenceClosings.get(binding) ?? binding) + 1
        for (; cursor < end; cursor++) {
          const token = references[cursor]!
          if ([",", ";", "}"].includes(token)
            || loopOpen !== undefined && ["of", "in", ")"].includes(token)
            || referenceLineBreaks.has(cursor) && endsAgentExpression(references.slice(binding, cursor))) break
          cursor = referenceClosings.get(cursor) ?? cursor
        }
        if (references[cursor] !== ",") break
        binding = cursor + 1
      }
      templateLocalBindings.push({ start, end, names })
    }
    const classFieldKeys = new Set<number>()
    const instanceFieldInitializers = new Set<number>()
    const classExpressionNames = new Set<number>()
    for (let index = 0; index < references.length; index++) {
      if (references[index] !== "class" || references[index - 1] === "." || [":", "("].includes(references[index + 1] ?? "")) continue
      if (isIdentifier(references[index + 1])
        && ["extends", "{"].includes(references[index + 2] ?? "")) classExpressionNames.add(index + 1)
      let body = index + 1
      while (body < references.length && references[body] !== "{") {
        body = (referenceClosings.get(body) ?? body) + 1
      }
      const end = referenceClosings.get(body)
      if (end === undefined) continue
      // Only member starts name fields. Initializers and computed keys still
      // read bindings, including assignments to an imported Channel.
      let memberStart = true
      let memberStatic = false
      for (let cursor = body + 1; cursor < end; cursor++) {
        const token = references[cursor]!
        if (referenceLineBreaks.has(cursor) && endsAgentExpression(references.slice(0, cursor))) memberStart = true
        if (token === ";") { memberStart = true; memberStatic = false; continue }
        if (memberStart && token === "static") { memberStatic = true; continue }
        if (memberStart && ["readonly", "declare", "public", "private", "protected", "abstract", "override", "accessor"].includes(token)) continue
        if (memberStart && token === "#" && isIdentifier(references[cursor + 1])) continue
        if (memberStart && isIdentifier(token)
          && (["=", ";", "}"].includes(references[cursor + 1] ?? "")
            || references[cursor + 1] === ":"
            || references[cursor + 1] === "?"
            || references[cursor + 1] === "!"
              && [":", "=", ";", "}"].includes(references[cursor + 2] ?? "")
              || referenceLineBreaks.has(cursor + 1) && (isIdentifier(references[cursor + 1]) || ["[", "#"].includes(references[cursor + 1] ?? "")))) {
          classFieldKeys.add(cursor)
          // Instance field initializers run only when an instance is created,
          // after the class expression itself has been evaluated. Do not let
          // captures in those initializers taint imported Channels. Static
          // fields execute during class evaluation and remain inspectable.
          if (!memberStatic && references[cursor + 1] === "=") {
            let initializer = cursor + 2
            let depth = 0
            for (; initializer < end; initializer++) {
              const value = references[initializer]!
              if (["(", "[", "{"].includes(value)) depth++
              else if ([")", "]", "}"].includes(value)) {
                if (depth === 0) break
                depth--
              }
              if (depth === 0 && value === ";") break
              if (depth === 0 && referenceLineBreaks.has(initializer)
                && endsAgentExpression(references.slice(cursor + 2, initializer))) break
              instanceFieldInitializers.add(initializer)
            }
          }
        }
        const closing = referenceClosings.get(cursor)
        if (closing !== undefined) {
          cursor = closing
        }
        memberStart = false
      }
    }
    const bindingReference = (index: number) => isIdentifier(references[index])
      && ![".", "#"].includes(references[index - 1] ?? "")
      && !(references[index + 1] === ":" && ["{", ","].includes(references[index - 1] ?? ""))
      && !methodKey(index)
      && !classFieldKeys.has(index)
      && !instanceFieldInitializers.has(index)
      && !classExpressionNames.has(index)
      && !templateLocalBindings.some(scope => index >= scope.start && index < scope.end && scope.names.has(references[index]!))
    const reassignedGlobalConversions = new Set<string>()
    // Template references are tokenized separately from the outer program,
    // so direct global conversion writes inside an interpolation must be
    // included in the same conservative reassignment set.
    for (let index = 0; index + 3 < references.length; index++) {
      if (references[index] !== "globalThis") continue
      let member = index + 1
      if (references[member] === ".") {
        const name = references[member + 1]
        if (["String", "Number", "Boolean"].includes(name ?? "")
          && assignmentOperator(member + 2, references)) reassignedGlobalConversions.add(name!)
      } else if (references[member] === "[" && references[member + 2] === "]"
        && ["String", "Number", "Boolean"].includes(references[member + 1] ?? "")
        && assignmentOperator(member + 3, references)) {
        reassignedGlobalConversions.add(references[member + 1]!)
      }
    }
    for (let index = 0; index < tokens.length; index++) {
      const objectEnd = intrinsicObjectEnd(index)
      const reflectEnd = intrinsicReflectEnd(index)
      const receiverEnd = objectEnd ?? reflectEnd
      if (receiverEnd === undefined) continue
      const member = memberAccess(receiverEnd - 1)
      const call = member === undefined ? undefined : memberCallEnd(member.end - 1, index)
      if (member !== undefined && tokens[call!] !== "(") continue
      if (member?.name === "setPrototypeOf") {
        reassignedGlobalConversions.add("String")
        reassignedGlobalConversions.add("Number")
        reassignedGlobalConversions.add("Boolean")
        continue
      }
      if (member?.name !== "defineProperty" && member?.name !== "defineProperties" && member?.name !== "set" && member?.name !== "assign") continue
      const callEnd = memberCallEnd(member.end - 1, index)
      if (tokens[callEnd] !== "(") continue
      const target = callEnd + 1
      let targetEnd = target
      let depth = 0
      for (; targetEnd < tokens.length; targetEnd++) {
        const token = tokens[targetEnd]!
        if (depth === 0 && token === ",") break
        if (["(", "[", "{"].includes(token)) depth++
        else if ([")", "]", "}"].includes(token)) depth--
      }
      if (!globalThisReceiver(target) || tokens[targetEnd] !== ",") continue
      // Bulk writes can replace any of the built-in conversion helpers without
      // exposing a direct member assignment.
      // Keep all conversions opaque because the source object may contain
      // computed or otherwise non-static property names.
      if (member.name === "assign" || member.name === "defineProperties") {
        reassignedGlobalConversions.add("String")
        reassignedGlobalConversions.add("Number")
        reassignedGlobalConversions.add("Boolean")
        continue
      }
      const property = resolveReference(target + 2)
      const name = propertyName(tokens[property] ?? "")
      if (["String", "Number", "Boolean"].includes(name)) reassignedGlobalConversions.add(name)
    }
    // Calls through aliases of intrinsic mutation methods have the same
    // effect as their literal receivers. Keep conversion calls conservative
    // when a trusted writer is assigned to a local, for example
    // `const define = Object.defineProperty; define(globalThis, "String", …)`.
    // The alias may be shadowed in a nested scope, so only use this as a
    // fail-closed signal when any invocation is present.
    const intrinsicWriterBindings = new Set<number>()
    for (const [binding, initializer] of declaratorInitializers) {
      if (!isIdentifier(tokens[binding] ?? "")) continue
      const objectEnd = intrinsicObjectEnd(initializer)
      const reflectEnd = intrinsicReflectEnd(initializer)
      const receiverEnd = objectEnd ?? reflectEnd
      if (receiverEnd === undefined) continue
      const member = memberAccess(receiverEnd - 1)
      if (member && ["defineProperty", "defineProperties", "set", "assign"].includes(member.name)) {
        const declaration = visibleDeclaration(binding)
        if (declaration !== undefined) intrinsicWriterBindings.add(declaration)
      }
    }
    // A writer alias can also be introduced by a later assignment (`let
    // define; define = Object.defineProperty`). Resolve that assignment to
    // its lexical binding so unrelated same-named calls stay independent.
    for (let index = 0; index < tokens.length; index++) {
      if (!isIdentifier(tokens[index] ?? "") || !assignmentOperator(index + 1)) continue
      const initializer = assignmentInitializer(index + 1)
      if (initializer === undefined) continue
      const objectEnd = intrinsicObjectEnd(initializer)
      const reflectEnd = intrinsicReflectEnd(initializer)
      const receiverEnd = objectEnd ?? reflectEnd
      if (receiverEnd === undefined) continue
      const member = memberAccess(receiverEnd - 1)
      if (!member || !["defineProperty", "defineProperties", "set", "assign"].includes(member.name)) continue
      const declaration = visibleDeclaration(index)
      if (declaration !== undefined) intrinsicWriterBindings.add(declaration)
    }
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index - 1] === ".") continue
      const declaration = visibleDeclaration(index)
      if (declaration === undefined || !intrinsicWriterBindings.has(declaration)) continue
      const call = memberCallEnd(index)
      if (tokens[call] !== "(") continue
      reassignedGlobalConversions.add("String")
      reassignedGlobalConversions.add("Number")
      reassignedGlobalConversions.add("Boolean")
    }
    // Computed member assignments can replace a global conversion without
    // exposing the property name as an identifier token (for example,
    // `globalThis["String"] = replacement`). Treat these as opaque too.
    for (let index = 0; index < tokens.length; index++) {
      // Member writes mark globalThis and its aliases mutated. Follow their
      // direct initializers and helpers with an exact globalThis return.
      // Reads through these receivers do not reassign conversions.
      const call = globalHelperCallEnd(index)
      const helperGlobal = call !== undefined
      if (!globalThisReceiver(index) && !helperGlobal) continue
      const member = call !== undefined ? memberAccess(call) : memberAccess(index)
      const memberEnd = memberCallEnd(call ?? index)
      if (member && ["String", "Number", "Boolean"].includes(member.name) && assignmentOperator(member.end)) {
        reassignedGlobalConversions.add(member.name)
      }
      else if (!member && memberEnd > (call ?? index) + 1 && assignmentOperator(memberEnd)) {
        // Unknown computed writes may replace a conversion helper. A bare
        // alias declaration or assignment does not write a member.
        reassignedGlobalConversions.add("String")
        reassignedGlobalConversions.add("Number")
        reassignedGlobalConversions.add("Boolean")
      }
    }
    // Only unshadowed global conversions are known calls. Nested opaque calls
    // and imported arguments still invalidate imported Channels.
    const conversionCall = (index: number) => {
      // Optional calls tokenize as `name`, `?`, `.`, `(`. Treat them like
      // ordinary calls while still resolving the conversion's binding.
      const nameIndex = references[index - 1] === "." && references[index - 2] === "?"
        ? index - 3
        : index - 1
      const name = references[nameIndex]!
      return references[index] === "(" && bindingReference(nameIndex)
        && ["String", "Number", "Boolean"].includes(name)
        && globalBindingAvailable(templateIndex, name)
        && !expressionArrowParameters.some(scope => templateIndex >= scope.start && templateIndex < scope.end && scope.names.has(name))
        && !reassignedGlobalConversions.has(name)
        && ![tokens, references].some(sequence => sequence.some((token, cursor) =>
          token === name && (assignmentOperator(cursor + 1, sequence) || ["+", "-"].includes(sequence[cursor + 1] ?? ""))
          && ![".", "?"].includes(sequence[cursor - 1] ?? "")
          && (sequence !== tokens || globalBindingUnshadowed(cursor, name))))
    }
    const hiddenCode = references.some((token, index) =>
      !uncalledFunctionBodies.some(body => index >= body.start && index < body.end)
      && ((bindingReference(index) && (token === "eval" || token === "import" && references[index + 1] !== "."))
      || ((token === "(" || token.startsWith("`"))
        && (isIdentifier(references[index - 1]) || [")", "]", ">", "."].includes(references[index - 1] ?? ""))
        && !methodKey(index - 1)
        && !functionExpressionCall(index - 1)
        && !(token === "(" && ![".", "?"].includes(references[index - 2] ?? "")
          && (["for", "if", "while", "switch", "catch", "with"].includes(references[index - 1] ?? "")
          || references[index - 1] === "await" && references[index - 2] === "for"))
        && !conversionCall(index))))
      // A tagged template also calls its tag. The tag is outside the
      // interpolation token stream, so treat it as opaque
      // to avoid trusting captured imported Channels that it may mutate.
      || opaqueCalls.has(templateIndex)
    if (hiddenCode) {
      invalidateCapturedBindings()
      for (const name of imported) mutatedBindings.add(name)
    }
    for (let index = 0; index < references.length; index++) {
      const name = references[index]!
      if (!bindingReference(index) || isFunctionParameter(templateIndex, name)
        || callbackParameters.some(scope => templateIndex >= scope.start && templateIndex < scope.end && scope.names.has(name))
        || expressionArrowParameters.some(scope => templateIndex >= scope.start && templateIndex < scope.end && scope.names.has(name))) continue
      const binding = visibleDeclaration(templateIndex, name)
      // A local capture with the same name cannot mutate the module import or
      // declaration. Keep the module-wide taint set tied to its resolved binding.
      if (binding !== undefined && (imported.has(name) || declarations.has(name))) {
        const declaration = variableDeclarations.get(binding)!
        const scope = tokens[declaration] === "var" ? variableScope(declaration) : tokenScopes[declaration]
        if (scope !== undefined) continue
      }
      if (imported.has(name) || declarations.has(name) || binding !== undefined) mutatedBindings.add(name)
    }
  }
  // Invoking an extracted member of an opaque result may mutate captured
  // options even though the invocation has no receiver or arguments.
  const invokedBindings = new Set<string>()
  for (let index = 0; index < tokens.length; index++) {
    const call = memberCallEnd(index)
    if (visibleDeclaration(index) !== undefined && opaqueCalls.has(call) && !trustedCalls.has(call)) {
      invokedBindings.add(tokens[index]!)
    }
  }
  // Defaults can alias captured options even when a helper has no arguments.
  // Keep these references opaque when local functions are invoked.
  if ([...opaqueCalls].some(call => !trustedCalls.has(call) && !parameterLists.has(call))) {
    for (const [initializer, end] of defaultParameterInitializers) {
      for (let reference = initializer; reference < end; reference++) {
        if (visibleDeclaration(reference) !== undefined) mutatedBindings.add(tokens[reference]!)
      }
    }
  }
  for (const call of opaqueCalls) {
    if (trustedCalls.has(call) || parameterLists.has(call)) continue
    // A write through an opaque call result may mutate a captured options
    // object even when the call has no arguments (`getOptions().pullRequest =
    // true`). Invalidate local bindings so Channel ownership is not inferred
    // from a stale initializer.
    let close = call + 1
    // A tagged template is one literal token, with its result immediately after it.
    const tagged = tokens[call]?.startsWith("`")
    let callNesting = tagged ? 0 : 1
    for (; close < tokens.length && callNesting > 0; close++) {
      if (["(", "[", "{"].includes(tokens[close]!)) callNesting++
      else if ([")", "]", "}"].includes(tokens[close]!)) callNesting--
    }
    if (callNesting === 0) {
      const memberEnd = memberCallEnd(close - 1, call)
      const update = ["+", "-"].includes(tokens[memberEnd] ?? "") && tokens[memberEnd + 1] === tokens[memberEnd]
      let receiver = call - 1
      while (receiver >= 0) {
        const opening = openingDelimiters.get(receiver)
        if (opening !== undefined) { receiver = opening - 1; continue }
        if (tokens[receiver] === "delete") break
        if (!isIdentifier(tokens[receiver]) && ![".", "("].includes(tokens[receiver])) break
        receiver--
      }
      if (memberEnd > close && (assignmentOperator(memberEnd) || update || tokens[memberEnd] === "(" || tokens[receiver] === "delete")) {
        invalidateCapturedBindings()
      }
    }
    let nesting = tagged ? 0 : 1
    for (let argument = call + 1; argument < tokens.length && nesting > 0; argument++) {
      if (["(", "[", "{"].includes(tokens[argument])) nesting++
      else if ([")", "]", "}"].includes(tokens[argument])) nesting--
      if (nesting > 0 && visibleDeclaration(argument) !== undefined) mutatedBindings.add(tokens[argument])
    }
  }
  // Thrown local values can be mutated through catch bindings. Treat this
  // escape like an opaque call instead of inferring from stale initializers.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "throw" || tokens[index - 1] === "." || tokens[index + 1] === ":" || parameterLists.has(index + 1)) continue
    // A method named `throw` may have generic parameters or a return type.
    let parameters = index + 1
    if (tokens[parameters] === "<") {
      while (parameters < tokens.length && !["(", ";", "{"].includes(tokens[parameters]!)) parameters++
    }
    if (tokens[parameters] === "(" && [...openingDelimiters].some(([close, opening]) =>
      opening === parameters && ["{", ":"].includes(tokens[close + 1]!))) continue
    let nesting = 0
    for (let reference = index + 1; reference < tokens.length; reference++) {
      const token = tokens[reference]!
      if (nesting === 0 && ([";", "}"].includes(token) || startsStatement(reference))) break
      if (["(", "[", "{"].includes(token)) nesting++
      else if ([")", "]", "}"].includes(token)) nesting--
      if ((visibleDeclaration(reference) !== undefined || (imported.has(token) && isModuleBinding(reference)))
        && tokens[reference - 1] !== "." && !isFunctionParameter(reference)) mutatedBindings.add(token)
    }
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [alias, targets] of assignedAliases) {
      if (invokedBindings.has(alias)) {
        for (const target of targets) {
          if (invokedBindings.has(target)) continue
          invokedBindings.add(target)
          changed = true
        }
      }
      if (!mutatedBindings.has(alias)) continue
      for (const target of targets) {
        if (mutatedBindings.has(target)) continue
        mutatedBindings.add(target)
        changed = true
      }
    }
  }
  if ([...opaqueResultBindings].some(name => mutatedBindings.has(name) || invokedBindings.has(name))) invalidateCapturedBindings()
  for (const name of new Set([...namedExports.keys(), ...pendingExports.keys()])) {
    const local = pendingExports.get(name) ?? name
    if (mutatedBindings.has(local)) opaqueExports.add(name)
  }

  function visibleDeclaration(index: number, name = tokens[index]): number | undefined {
    const visibleScopes: (number | undefined)[] = []
    for (let scope = tokenScopes[index]; scope !== undefined; scope = scopeParents.get(scope)) visibleScopes.push(scope)
    visibleScopes.push(undefined)
    const parameterScope = callbackParameters.findLast(scope => index >= scope.start && index < scope.end && scope.names.has(name))
    for (const scope of visibleScopes) {
      let binding: number | undefined
      for (const [i, declaration] of variableDeclarations) {
        if (i < (parameterScope?.start ?? 0)
          || (tokens[i + 1] !== name && !destructuredBindings.get(i)?.has(name))) continue
        const bindingScope = tokens[declaration] === "var" ? variableScope(declaration) : tokenScopes[declaration]
        if (bindingScope !== scope) continue
        if (binding === undefined || i < index) binding = i
      }
      if (binding === undefined) continue
      return binding
    }
    return undefined
  }

  function globalObjectReference(index: number): boolean {
    return globalBindingReference(index, "Object")
  }

  function intrinsicObjectEnd(index: number): number | undefined {
    if (tokens[index] === "(") {
      const inner = intrinsicObjectEnd(index + 1)
      if (inner !== undefined && tokens[inner] === ")") return inner + 1
      return
    }
    if (globalObjectReference(index)) return index + 1
    if (!globalBindingReference(index, "globalThis")) return
    const member = memberAccess(index)
    if (member?.name === "Object") return member.end
  }

  function intrinsicReflectEnd(index: number): number | undefined {
    if (tokens[index] === "(") {
      const inner = intrinsicReflectEnd(index + 1)
      if (inner !== undefined && tokens[inner] === ")") return inner + 1
      return
    }
    if (globalBindingReference(index, "Reflect")) return index + 1
    if (!globalBindingReference(index, "globalThis")) return
    const member = memberAccess(index)
    if (member?.name === "Reflect") return member.end
  }

  function globalBindingReference(index: number, name: string): boolean {
    return tokens[index] === name && tokens[index - 1] !== "." && globalBindingAvailable(index, name)
  }

  function globalThisReceiver(index: number, seen = new Set<number>()): boolean {
    while (tokens[index] === "(") index++
    if (!isIdentifier(tokens[index]) || seen.has(index) || tokens[index - 1] === ".") return false
    seen.add(index)
    if (tokens[index] === "globalThis") return globalBindingUnshadowed(index, "globalThis")
    if (isFunctionParameter(index) || callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]!))) return false

    // A local helper can return the intrinsic global object without having an
    // initializer for this traversal to follow (for example,
    // `function globals() { return globalThis }`). Treat only a direct,
    // unmodified function declaration with that exact return expression as an
    // alias; arbitrary helper calls remain opaque.
    if (!mutatedBindings.has(tokens[index]!) && globalHelperCallEnd(index) !== undefined) return true
    const binding = visibleDeclaration(index)
    const initializer = binding === undefined ? undefined : declaratorInitializers.get(binding + 1)
    if (initializer === undefined) return false
    let value = initializer
    while (tokens[value] === "(") value++
    // Member writes mark the receiver mutated, but do not sever its alias.
    // Follow only direct initializers so unrelated global properties stay local.
    // TypeScript assertions can follow an aliased global object expression.
    // Keep the assertion attached to the same expression while rejecting
    // actual member access or opaque helper results.
    if (![";", ",", ")", undefined, "!", "as", "satisfies"].includes(tokens[value + 1]) && !startsStatement(value + 1)) return false
    return globalThisReceiver(value, seen)
  }

  function globalHelperCallEnd(index: number): number | undefined {
    const member = memberAccess(index)
    const indirect = member && ["call", "apply", "bind"].includes(member.name)
    const call = indirect ? member.end : index + 1
    if (tokens[call] !== "(") return undefined
    if (!functionGlobalHelper(index) && !arrowGlobalHelper(index)) return undefined
    const boundEnd = [...openingDelimiters].find(([, opening]) => opening === call)?.[0]
    if (boundEnd === undefined) return undefined
    // A bound helper is invoked by calling the function returned from bind,
    // so follow the second call as well (for example globals.bind(null)()).
    if (member?.name === "bind") {
      const invocation = boundEnd + 1
      if (tokens[invocation] !== "(") return undefined
      return [...openingDelimiters].find(([, opening]) => opening === invocation)?.[0]
    }
    return boundEnd
  }

  function functionGlobalHelper(reference: number): boolean {
    const name = tokens[reference]!
    if (isFunctionParameter(reference) || callbackParameters.some(scope =>
      reference >= scope.start && reference < scope.end && scope.names.has(name))
      || expressionArrowParameters.some(scope => reference >= scope.start && reference < scope.end && scope.names.has(name))) return false
    // A nearer variable binding shadows an outer function declaration with
    // the same name. Only the binding visible at the call site may qualify.
    if (visibleDeclaration(reference) !== undefined) return false
    // Resolve the helper in the invocation's lexical scope. A name-only scan
    // can accidentally use a top-level helper when a local declaration shadows
    // it and returns an unrelated object.
    const visibleScopes: (number | undefined)[] = []
    for (let scope = tokenScopes[reference]; ; scope = scopeParents.get(scope!)) {
      visibleScopes.push(scope)
      if (scope === undefined) break
    }
    const declarations = visibleScopes.flatMap(scope => tokens.flatMap((token, index) =>
      token === "function" && tokens[index + 1] === name && tokenScopes[index] === scope ? [index] : []))
    const declaration = declarations[0]
    if (declaration === undefined) return false
    if (tokens[declaration - 1] === "async") return false
    const parameters = declaration + 2
    if (tokens[parameters] !== "(") return false
    const parameterEnd = [...openingDelimiters].find(([, opening]) => opening === parameters)?.[0]
    const body = parameterEnd === undefined ? undefined : parameterEnd + 1
    const bodyEnd = body === undefined ? undefined : [...openingDelimiters].find(([, opening]) => opening === body)?.[0]
    if (body === undefined || bodyEnd === undefined || tokens[body] !== "{") return false
    let cursor = body + 1
    while (cursor < bodyEnd && tokens[cursor] === ";") cursor++
    if (tokens[cursor] !== "return") return false
    cursor++
    while (tokens[cursor] === "(") cursor++
    if (tokens[cursor] !== "globalThis" || !globalBindingUnshadowed(cursor, "globalThis")) return false
    cursor++
    while (tokens[cursor] === ")") cursor++
    while (tokens[cursor] === ";") cursor++
    if (cursor === bodyEnd) return true
    return false
  }

  function arrowGlobalHelper(reference: number): boolean {
    const name = tokens[reference]!
    if (isFunctionParameter(reference) || callbackParameters.some(scope =>
      reference >= scope.start && reference < scope.end && scope.names.has(name))
      || expressionArrowParameters.some(scope => reference >= scope.start && reference < scope.end && scope.names.has(name))) return false
    for (let index = 0; index + 4 < tokens.length; index++) {
      if (tokens[index] !== name || tokens[index + 1] !== "=") continue
      // Match the lexical binding at the call site. This covers both a
      // declarator initializer and a later assignment (`let globals; globals
      // = () => globalThis`) without conflating shadowed names.
      if (visibleDeclaration(reference) !== visibleDeclaration(index)) continue
      const parameters = index + 2
      const parameterEnd = tokens[parameters] === "("
        ? [...openingDelimiters].find(([, opening]) => opening === parameters)?.[0]
        : isIdentifier(tokens[parameters]) ? parameters : undefined
      if (parameterEnd === undefined || tokens[parameterEnd + 1] !== "=" || tokens[parameterEnd + 2] !== ">") continue
      let cursor = parameterEnd + 3
      const parentheses: number[] = []
      while (tokens[cursor] === "(") parentheses.push(cursor++)
      if (tokens[cursor] === "{") {
        const bodyEnd = [...openingDelimiters].find(([, opening]) => opening === cursor)?.[0]
        if (bodyEnd === undefined) continue
        cursor++
        while (tokens[cursor] === ";") cursor++
        if (tokens[cursor] !== "return") continue
        cursor++
        while (tokens[cursor] === "(") cursor++
        if (tokens[cursor] !== "globalThis" || !globalBindingUnshadowed(cursor, "globalThis")) continue
        cursor++
        while (tokens[cursor] === ")") cursor++
        while (tokens[cursor] === ";") cursor++
        if (cursor === bodyEnd) return true
        continue
      }
      if (tokens[cursor] !== "globalThis" || !globalBindingUnshadowed(cursor, "globalThis")) continue
      cursor++
      while (parentheses.length > 0 && openingDelimiters.get(cursor) === parentheses.at(-1)) {
        parentheses.pop()
        cursor++
      }
      if (parentheses.length === 0 && ([";", ",", ")", "]", "}", undefined].includes(tokens[cursor]) || startsStatement(cursor))) return true
    }
    return false
  }

  function globalBindingAvailable(index: number, name: string): boolean {
    return !mutatedBindings.has(name) && globalBindingUnshadowed(index, name)
  }

  function globalBindingUnshadowed(index: number, name: string): boolean {
    if (imported.has(name) || visibleDeclaration(index, name) !== undefined || isFunctionParameter(index, name)
      || callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(name))
      || expressionArrowParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(name))) return false
    for (let scope = tokenScopes[index]; ; scope = scopeParents.get(scope!)) {
      if (tokens.some((token, declaration) => ["function", "class"].includes(token)
        && tokens[declaration + 1] === name && tokenScopes[declaration] === scope)) return false
      if (scope === undefined) return true
    }
  }

  function conditionalBranches(index: number): [number, number] | undefined {
    let expressionDepth = 0
    let conditionalDepth = 0
    let consequent: number | undefined
    for (let i = index; i < tokens.length; i++) {
      const token = tokens[i]
      if (expressionDepth === 0) {
        if (i > index && conditionalDepth === 0 && startsStatement(i)) break
        if ((declarationKeyword(i) || [";", ",", ":", "export", ")", "}", "]"].includes(token)) && conditionalDepth === 0) break
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

  function staticConditionalBranch(index: number): number | undefined {
    const branches = conditionalBranches(index)
    if (branches === undefined) return
    const condition = staticBooleanValue(index, branches[0] - 1)
    return condition === undefined ? undefined : branches[condition ? 0 : 1]
  }

  function staticBooleanValue(index: number, boundary?: number, seen = new Set<number>()): boolean | undefined {
    let condition = index
    while (tokens[condition] === "(") condition++
    if (hasLogicalOperator(condition)) return
    let end = condition + 1
    function skipAssertions() {
      while (tokens[end] === "as" || tokens[end] === "satisfies" || (tokens[end] === "!" && tokens[end + 1] !== "=")) {
        end = tokens[end] === "!" ? end + 1 : skipAssertion(end)
      }
    }
    skipAssertions()
    for (let opening = condition - 1; opening >= index; opening--) {
      if (tokens[end] !== ")" || openingDelimiters.get(end) !== opening) return
      end++
      skipAssertions()
    }
    if (boundary === undefined
      ? ![";", ",", ")", "}", "]", undefined].includes(tokens[end]) && !startsStatement(end)
      : end !== boundary) return
    if (tokens[condition] === "true" || tokens[condition] === "false") return tokens[condition] === "true"
    const binding = visibleDeclaration(condition)
    if (binding === undefined || binding > condition || destructuredBindings.has(binding)
      || mutatedBindings.has(tokens[condition]!) || seen.has(binding)) return
    seen.add(binding)
    let initializer = declaratorInitializers.get(binding + 1)
    if (initializer === undefined) {
      let cursor = binding + 2
      while (cursor < condition && !["=", ";", ","].includes(tokens[cursor]!)) cursor++
      if (tokens[cursor] === "=") initializer = cursor + 1
    }
    return initializer === undefined ? undefined : staticBooleanValue(initializer, undefined, seen)
  }

  function hasLogicalOperator(index: number): boolean {
    let depth = 0
    for (let i = index; i < tokens.length; i++) {
      const token = tokens[i]
      if (depth === 0 && [",", ";", ")", "]", "}"].includes(token)) break
      if (depth === 0 && ["|", "&", "?"].includes(token) && tokens[i + 1] === token) {
        return true
      }
      if (["(", "[", "{"].includes(token)) depth++
      else if ([")", "]", "}"].includes(token)) depth--
    }
    return false
  }

  function capabilityOwnsWorkspace(index: number, seen = new Set<number>()): boolean {
    if (tokens[index] === "." && tokens[index + 1] === "." && tokens[index + 2] === ".") index += 3
    const outerIndex = index
    const outerBranches = conditionalBranches(index)
    if (outerBranches) return outerBranches.some(branch => capabilityOwnsWorkspace(branch, new Set(seen)))
    let wrappers = 0
    while (tokens[index] === "(") {
      let end = index + 1
      for (let depth = 1; end < tokens.length && depth > 0; end++) {
        if (["(", "[", "{"].includes(tokens[end])) depth++
        else if ([")", "]", "}"].includes(tokens[end])) depth--
        else if (depth === 1 && tokens[end] === ",") {
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a sequence Capability expression. Use a literal Capability list, or add an explicit Workspace ownership marker.")
        }
      }
      while (tokens[end] === "!" || tokens[end] === "as" || tokens[end] === "satisfies") {
        end = tokens[end] === "!" ? end + 1 : skipAssertion(end)
      }
      if (["(", ".", "[", "?"].includes(tokens[end])) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an opaque Capability expression. Use a literal Capability list with direct local bindings, or add workspace: {} to the Agent definition when the Capabilities own a Workspace.")
      }
      index++
      wrappers++
    }
    if (hasLogicalOperator(outerIndex) || hasLogicalOperator(index)) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect a logical Capability expression. Use a literal Capability list with direct local bindings, or add an explicit Workspace ownership marker.")
    }
    if (tokens[index] === "await") {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an awaited Capability expression. Use a literal Capability list, or add an explicit Workspace ownership marker.")
    }
    if (seen.has(index)) return false
    seen.add(index)
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => capabilityOwnsWorkspace(branch, new Set(seen)))
    if (["[", "{"].includes(tokens[index])) {
      let end = index + 1
      let brackets = 1
      for (; end < tokens.length && brackets > 0; end++) {
        if (["[", "{", "("].includes(tokens[end])) brackets++
        else if (["]", "}", ")"].includes(tokens[end])) brackets--
      }
      while (end < tokens.length) {
        if (tokens[end] === ")" && wrappers > 0) { end++; wrappers--; continue }
        if (tokens[end] === "as" || tokens[end] === "satisfies") { end = skipAssertion(end); continue }
        break
      }
      if ([".", "[", "?", "!"].includes(tokens[end])) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an opaque Capability expression. Use a literal Capability list with direct local bindings, or add workspace: {} to the Agent definition when the Capabilities own a Workspace.")
      }
      if (tokens[index] === "{") {
        const options = properties(index, true, true)
        const workspace = options.get("workspace")
        if (workspace !== undefined && capabilityWorkspaceOwnsWorkspace(workspace)) return true
        const nested = options.get("capabilities")
        return nested !== undefined && capabilityOwnsWorkspace(nested, seen)
      }
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
    const firstPartyFactory = importedCapabilityFactories.get(tokens[index]!)
      ?? (importedCapabilityNamespaces.has(tokens[index]!) && tokens[index + 1] === "." && firstPartyCapabilityFactories.has(tokens[index + 2]!) ? tokens[index + 2] : undefined)
    if (firstPartyFactory !== undefined && binding === undefined && !parameterScope) {
      let call = importedCapabilityNamespaces.has(tokens[index]!) ? index + 3 : index + 1
      if (tokens[call] === "<") call = skipTypeArguments(call)
      const close = [...openingDelimiters].find(([, opening]) => opening === call)?.[0]
      if (mutatedBindings.has(tokens[index]!) || tokens[call] !== "(" || close === undefined || hasChannelContinuation(close + 1)) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect an opaque first-party Capability call. Use an unchanged imported helper call, or add an explicit Workspace ownership marker.")
      }
      // Storage and usage helpers do not allocate an Agent Workspace. Transcription
      // requires a writable Workspace only when artifact persistence is enabled.
      if (firstPartyFactory !== "transcribe") return false
      const options = properties(call + 1, false, true, () => {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect opaque transcription settings. Use literal artifact settings, or add an explicit Workspace ownership marker.")
      })
      const artifacts = options.get("artifacts")
      return artifacts !== undefined && capabilityWorkspaceOwnsWorkspace(artifacts)
    }
    let capabilityCall = binding !== undefined || parameterScope ? -1 : tokens[index] === "defineCapability" || importedCapabilityBindings.has(tokens[index])
      ? index + 1
      : importedNamespaces.has(tokens[index]) && tokens[index + 1] === "." && tokens[index + 2] === "defineCapability"
        ? index + 3
        : -1
    if (tokens[capabilityCall] === "<") capabilityCall = skipTypeArguments(capabilityCall)
    if (tokens[capabilityCall] === "(" && tokens[capabilityCall + 1] === ")" && tokens[capabilityCall + 2] === "(") capabilityCall += 2
    if (tokens[capabilityCall] === "(") {
      const options = properties(capabilityCall + 1, false, true)
      const workspace = options.get("workspace")
      if (workspace !== undefined && capabilityWorkspaceOwnsWorkspace(workspace)) return true
      const nested = options.get("capabilities")
      return nested !== undefined && capabilityOwnsWorkspace(nested, seen)
    }
    if (!isIdentifier(tokens[index] ?? "")) return false
    let suffix = index + 1
    while (tokens[suffix] === "!") suffix++
    if (binding !== undefined) {
      if (destructuredBindings.has(binding)) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect a destructured Capability binding. Add workspace: {} to the Agent definition when the Capability owns a Workspace, or use a direct local binding so discovery can inspect it.")
      }
      if (["(", "<", ".", "["].includes(tokens[suffix]) || (tokens[suffix] === "?" && tokens[suffix + 1] === ".")) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect a local Capability member or helper call. Add workspace: {} to the Agent definition when the Capability owns a Workspace, or use a direct local binding so discovery can inspect it.")
      }
      // Later declarations shadow outer bindings before their initializer runs.
      if (binding > index) return false
      if (mutatedBindings.has(tokens[index])) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect a mutable Capability binding. Use an unchanged local Capability binding, or add workspace: {} to the Agent definition when the Capability owns a Workspace.")
      }
      let initializer = binding + 2
      while (initializer < index && !["=", ";", ","].includes(tokens[initializer])) initializer++
      return tokens[initializer] === "=" && capabilityOwnsWorkspace(initializer + 1, seen)
    }
    if (parameterScope) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an option-derived Capability expression. Use a literal Capability list with direct local bindings, or add an explicit Workspace ownership marker to the Agent definition.")
    }
    if (imported.has(tokens[index])) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an imported Capability. Add workspace: {} to the Agent definition when the Capability owns a Workspace, or define the Capability locally so discovery can inspect it.")
    }
    if (!parameterScope && !imported.has(tokens[index]) && (tokens[index] === "new" || ["(", "<"].includes(tokens[suffix]) || (tokens[index] === "Array" && tokens[memberCallEnd(index)] === "(") || [".", "["].includes(tokens[suffix]) || (tokens[suffix] === "?" && tokens[suffix + 1] === "."))) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an opaque Capability expression. Use a literal Capability list with direct local bindings, or add workspace: {} to the Agent definition when the Capabilities own a Workspace.")
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

  function skipAssertion(index: number): number {
    let end = index + 1
    let depth = 0
    for (; end < tokens.length; end++) {
      const token = tokens[end]
      if (depth === 0 && [")", ",", ";", "}"].includes(token)) break
      if (["(", "[", "{", "<"].includes(token)) depth++
      else if ([")", "]", "}", ">"].includes(token) && tokens[end - 1] !== "=") depth--
    }
    return end
  }

  function memberCallEnd(index: number, receiverStart = index): number {
    let end = index + 1
    let wrappers = 0
    for (let i = receiverStart - 1; tokens[i] === "("; i--) wrappers++
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
        end = skipAssertion(end)
        continue
      }
      if (tokens[end] === ")" && wrappers > 0) { wrappers--; end++; continue }
      if (tokens[end] === ")" && hasAngleAssertion(index)) { end++; continue }
      break
    }
    return end
  }

  function hasAngleAssertion(index: number): boolean {
    if (tokens[index - 1] !== ">") return false
    let depth = 0
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (tokens[cursor] === ">") depth++
      else if (tokens[cursor] === "<") {
        depth--
        if (depth === 0) return tokens[cursor - 1] === "("
      }
    }
    return false
  }

  function resolveReference(index: number, seen = new Set<number>(), preserveCalls = false): number {
    while (tokens[index] === "(" || tokens[index] === "<") {
      if (tokens[index] === "<") { index = skipTypeArguments(index); continue }
      if (preserveCalls) {
        let depth = 1
        let close = index + 1
        for (; close < tokens.length && depth > 0; close++) {
          if (tokens[close] === "(") depth++
          else if (tokens[close] === ")") depth--
        }
        if (depth === 0 && hasChannelContinuation(close)) return index
      }
      let last = index + 1
      let depth = 1
      for (let i = index + 1; i < tokens.length && depth > 0; i++) {
        if (["(", "[", "{"].includes(tokens[i])) depth++
        else if ([")", "]", "}"].includes(tokens[i])) depth--
        else if (depth === 1 && tokens[i] === ",") last = i + 1
      }
      index = last
    }
    if (seen.has(index)) return index
    seen.add(index)
    if (preserveCalls) {
      const call = memberCallEnd(index)
      if (tokens[call] === "(" || [".", "["].includes(tokens[index + 1]) || (tokens[index + 1] === "?" && tokens[index + 2] === ".")) return index
    }
    const binding = visibleDeclaration(index)
    if (binding !== undefined) {
      if (mutatedBindings.has(tokens[index]!)) return index
      if (destructuredBindings.has(binding)) {
        const aliases = assignedAliases.get(tokens[index]!)
        if (aliases?.size === 1) {
          const target = declarations.get([...aliases][0]!)
          if (target !== undefined) {
            const resolved = resolveReference(target, seen, preserveCalls)
            if (factoryCall(resolved, "channelHelper") !== undefined) return resolved
          }
          else {
            const importedReference = destructuredImportedHelpers.get(binding)?.get(tokens[index]!)
            if (importedReference !== undefined && isModuleBinding(importedReference)
              && !mutatedBindings.has(tokens[importedReference]!)) return importedReference
          }
        }
        return index
      }
      if (binding > index) return index
      const declaratorInitializer = declaratorInitializers.get(binding + 1)
      if (declaratorInitializer !== undefined) return resolveReference(declaratorInitializer, seen, preserveCalls)
      let initializer = binding + 2
      while (initializer < index && !["=", ";", ","].includes(tokens[initializer])) initializer++
      return tokens[initializer] === "=" ? resolveReference(initializer + 1, seen, preserveCalls) : index
    }
    if (callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))) return index
    const reference = declarations.get(tokens[index])
    return reference === undefined ? index : resolveReference(reference, seen, preserveCalls)
  }

  function capabilityWorkspaceOwnsWorkspace(index: number, seen = new Set<number>()): boolean {
    const outerBranch = staticConditionalBranch(index)
    if (outerBranch !== undefined) return capabilityWorkspaceOwnsWorkspace(outerBranch, new Set(seen))
    const outerBranches = conditionalBranches(index)
    index = resolveReference(index)
    const staticBranch = staticConditionalBranch(index)
    if (staticBranch !== undefined) return capabilityWorkspaceOwnsWorkspace(staticBranch, new Set(seen))
    if (outerBranches !== undefined || conditionalBranches(index) !== undefined) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect a conditional Capability Workspace expression. Use a statically known condition, or add workspace: {} to the Agent definition when the Capability owns a Workspace.")
    }
    if (seen.has(index)) throw new Error("[vitehub] Agent Workspace discovery cannot inspect a cyclic Capability Workspace expression. Use a literal Workspace value.")
    seen.add(index)
    if (undefinedValue(index)) return false
    const signedNumber = ["-", "+"].includes(tokens[index])
    const number = tokens[index + (signedNumber ? 1 : 0)]
    const numericZero = /^(?:\d|\.\d)/.test(number ?? "") && Number(number!.replace(/_/g, "").replace(/n$/, "")) === 0
    const numericIndex = index + (signedNumber ? 1 : 0)
    const numericNaN = globalBindingReference(numericIndex, "NaN")
    if (!["false", "null", '""', "''", "``"].includes(tokens[index]) && !numericZero && !numericNaN) return true
    // A compound expression starting with a falsy literal may still return a
    // Workspace. Numeric literals are complete tokens, including decimal and radix forms.
    let end = index + ((numericZero || numericNaN) && signedNumber ? 2 : 1)
    let scope = tokenScopes[index]
    for (;;) {
      if (tokens[end] === "as" || tokens[end] === "satisfies") { end = skipAssertion(end); continue }
      if (tokens[end] === "!" && tokens[end + 1] !== "=") { end++; continue }
      if (tokens[end] === ")" && openingDelimiters.get(end) === scope && tokens[scope!] === "(") {
        end++
        scope = scopeParents.get(scope!)
        continue
      }
      break
    }
    if ((tokens[end] === "|" && tokens[end + 1] === "|")
      || (tokens[end] === "?" && tokens[end + 1] === "?" && tokens[index] === "null")) {
      return capabilityWorkspaceOwnsWorkspace(end + 2, seen)
    }
    if ((tokens[end] === "&" && tokens[end + 1] === "&")
      || (tokens[end] === "?" && tokens[end + 1] === "?")) {
      // A short-circuit conjunction or non-nullish coalescing preserves the falsy left value.
      // Mixed logical expressions need evaluation beyond literal inference.
      let depth = 0
      let expressionScope = scope
      for (let cursor = end + 2; cursor < tokens.length; cursor++) {
        const token = tokens[cursor]
        if (depth === 0 && token === ")" && openingDelimiters.get(cursor) === expressionScope && tokens[expressionScope!] === "(") {
          expressionScope = scopeParents.get(expressionScope!)
          continue
        }
        if (depth === 0 && [",", ";", ":", ")", "]", "}"].includes(token)) break
        if ((token === "|" && tokens[cursor + 1] === "|") || token === "?") {
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a compound Capability Workspace expression. Use a literal Workspace value, or add workspace: {} to the Agent definition when the Capability owns a Workspace.")
        }
        if (["(", "[", "{"].includes(token)) depth++
        else if ([")", "]", "}"].includes(token)) depth--
      }
      return false
    }
    return ![",", ";", ":", ")", "]", "}"].includes(tokens[end])
  }

  function undefinedValue(index: number): boolean {
    index = resolveReference(index)
    if (tokens[index] !== "void") return tokens[index] === "undefined"
    let depth = 0
    for (let i = index + 1; i < tokens.length; i++) {
      const token = tokens[i]
      if (depth === 0 && [",", ";", ")", "]", "}"].includes(token)) break
      if (depth === 0 && ["|", "&", "?", "+", "-", "*", "/", "%", "<", ">", "=", "!"].includes(token)) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect a compound void expression. Use a direct Workspace value or an explicit ownership marker.")
      }
      if (["(", "[", "{"].includes(token)) depth++
      else if ([")", "]", "}"].includes(token)) depth--
    }
    return true
  }

  function propertyName(token: string): string {
    if (!/^["'`]/.test(token)) return token
    if (invalidModuleLiteral(token)) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect an escaped settings key. Use an unescaped literal key.")
    }
    return moduleSpecifier(token)
  }

  function properties(index: number, inspectChannels = false, inspectSettings = false, onOpaqueSettings?: () => void, onPrototypeSettings?: () => void): Map<string, number> {
    const result = new Map<string, number>()
    index = resolveReference(index)
    // Preserve object literals wrapped in value-preserving helpers such as
    // Object.freeze({ ... }).
    if (globalObjectReference(index) && tokens[index + 1] === "." && tokens[index + 2] === "freeze" && tokens[index + 3] === "(") {
      index = resolveReference(index + 4)
    }
    if (inspectChannels && imported.has(tokens[index]) && visibleDeclaration(index) === undefined
      && !callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))) {
      let referenceEnd = index + 1
      let member = index
      while (true) {
        const access = memberAccess(member)
        if (access === undefined) break
        referenceEnd = access.end
        member = access.end - 1
      }
      if (!["(", "<"].includes(tokens[referenceEnd])
        && !(tokens[referenceEnd] === "?" && tokens[referenceEnd + 1] === "." && tokens[referenceEnd + 2] === "(")) {
        throw importedChannelError()
      }
    }
    if (tokens[index] !== "{") {
      onOpaqueSettings?.()
      if (inspectSettings) {
        throw new Error("[vitehub] Agent Workspace discovery cannot inspect opaque Agent settings. Define settings locally, or add an explicit workspace: {} ownership marker or named Workspace reference to the Agent definition.")
      }
      return result
    }
    let depth = 0
    let atProperty = true
    for (let i = index + 1; i < tokens.length; i++) {
      let token = tokens[i]
      if (depth === 0 && token === "}") break
      if (depth === 0 && atProperty) {
        if ((token === "get" || token === "set") && ![":", ",", "}", "("].includes(tokens[i + 1])) {
          // An accessor computes its value when the Channel reads it.
          if (inspectChannels) throw opaqueChannelError()
          onOpaqueSettings?.()
          atProperty = false
        } else if (token === "." && tokens[i + 1] === "." && tokens[i + 2] === ".") {
          const spread = properties(i + 3, inspectChannels, inspectSettings, () => {
            // Opaque spreads can replace an earlier Workspace marker. A later
            // explicit field, including one inside this spread, restores it.
            result.delete("workspace")
            onOpaqueSettings?.()
          })
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
            else {
              result.delete("workspace")
              onOpaqueSettings?.()
            }
            // Continue depth tracking at the value separator or method opener.
            // The computed key's brackets have already been consumed.
            i = close
            token = tokens[i]
            atProperty = false
          }
        } else if (tokens[i + 1] === ":") {
          const name = propertyName(token)
          if (name === "__proto__") {
            if (inspectChannels) throw opaqueChannelError()
            result.delete("workspace")
            onOpaqueSettings?.()
            onPrototypeSettings?.()
          } else result.set(name, i + 2)
        }
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

  // Returns the first-party Channel helper name for a call such as
  // `github(...)`, `channels.github(...)`, or an alias of either.
  function memberAccess(index: number): { name: string, end: number } | undefined {
    // TypeScript assertions can appear between a receiver and its member,
    // for example `(globalThis as object).String` or `(globalThis!).String`.
    let receiverEnd = index + 1
    let wrapped = tokens[index - 1] === "("
    while (receiverEnd < tokens.length) {
      if (tokens[receiverEnd] === "!") {
        wrapped = true
        receiverEnd++
        continue
      }
      if (tokens[receiverEnd] === "as" || tokens[receiverEnd] === "satisfies") {
        wrapped = true
        // Type assertions can contain qualified names, arrays, and nested
        // function types. Skip the full type before resolving the member.
        receiverEnd = skipAssertion(receiverEnd)
        if (tokens[receiverEnd] === ")") receiverEnd++
        continue
      }
      if (tokens[receiverEnd] === ")" && wrapped) {
        receiverEnd++
        continue
      }
      break
    }
    if (tokens[receiverEnd] === ".") {
      return { name: tokens[receiverEnd + 1]!, end: receiverEnd + 2 }
    }
    if (tokens[receiverEnd] === "?" && tokens[receiverEnd + 1] === "." && !["(", "["].includes(tokens[receiverEnd + 2]!)) {
      return { name: tokens[receiverEnd + 2]!, end: receiverEnd + 3 }
    }
    const bracketStart = tokens[receiverEnd] === "[" ? receiverEnd
      : tokens[receiverEnd] === "?" && tokens[receiverEnd + 1] === "." && tokens[receiverEnd + 2] === "[" ? receiverEnd + 2
      : undefined
    if (bracketStart !== undefined && tokens[bracketStart + 2] === "]" && /^['"`]/.test(tokens[bracketStart + 1] ?? "")) {
      return { name: propertyName(tokens[bracketStart + 1]!), end: bracketStart + 3 }
    }
  }

  function channelHelper(index: number): { call: number, helper: string } | undefined {
    const call = factoryCall(index, "channelHelper")
    if (call === undefined) return
    const reference = resolveReference(index)
    const helper = destructuredChannelHelper(reference)?.helper
      ?? importedChannelFactories.get(tokens[reference])
      ?? memberAccess(reference)?.name
    return helper === undefined ? undefined : { call, helper }
  }

  function destructuredChannelHelper(index: number) {
    const binding = visibleDeclaration(index)
    if (binding === undefined || binding > index || mutatedBindings.has(tokens[index]!)) return
    const helper = destructuredChannelHelpers.get(binding)?.get(tokens[index]!)
    if (!helper || visibleDeclaration(helper.reference) !== undefined || mutatedBindings.has(tokens[helper.reference]!)
      || callbackParameters.some(scope => helper.reference >= scope.start && helper.reference < scope.end && scope.names.has(tokens[helper.reference]!))) return
    return helper
  }

  function factoryCall(index: number, name: "defineAgent" | "defineChannel" | "defineCapability" | "channelHelper" = "defineAgent"): number | undefined {
    const reference = resolveReference(index)
    const destructuredHelper = name === "channelHelper" ? destructuredChannelHelper(reference) : undefined
    if ((!destructuredHelper && visibleDeclaration(reference) !== undefined) || callbackParameters.some(scope =>
      reference >= scope.start && reference < scope.end && scope.names.has(tokens[reference]))) return undefined
    // A binding to an Agent value is not an alias of the factory itself.
    let identityEnd = reference
    while (true) {
      const access = memberAccess(identityEnd)
      if (access === undefined) break
      identityEnd = access.end
    }
    if (identityEnd === reference) identityEnd++
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
    if (name === "channelHelper") {
      // Channel helpers are trusted only when imported from the Channel entry.
      if (!destructuredHelper && !importedChannelFactories.has(factory) && !(importedChannelNamespaces.has(factory)
        && firstPartyChannelFactories.has(memberAccess(reference)?.name ?? ""))) return undefined
    }
    else {
      const bindings = name === "defineAgent" ? importedAgentBindings : name === "defineCapability" ? importedCapabilityBindings : importedChannelBindings
      const namespaces = name === "defineChannel" ? importedChannelNamespaces : importedNamespaces
      if (!(factory === name && !imported.has(factory)) && !bindings.has(factory) &&
          !(namespaces.has(factory) && tokens[reference + 1] === "." && tokens[reference + 2] === name)) return undefined
    }
    let call = index + 1
    while (true) {
      const access = memberAccess(index)
      if (access === undefined) break
      call = access.end
      index = access.end - 1
    }
    if (tokens[call] === "?" && tokens[call + 1] === ".") call += 2
    if (tokens[call] === "<") call = skipTypeArguments(call)
    return tokens[call] === "(" ? call : undefined
  }

  function opaqueChannelError(): Error {
    return new Error("[vitehub] Agent Workspace discovery cannot inspect a local Channel factory or opaque Channel value or call. Use a local Channel object or a first-party Channel helper call with literal options, or add workspace: {} to the Agent definition when the Channel owns a Workspace.")
  }

  function pullRequestError(): Error {
    return new Error("[vitehub] Agent Workspace discovery cannot inspect a dynamic GitHub pullRequest option. Use a literal pullRequest value and a literal pullRequest.workspace value, or add workspace: {} to the Agent definition when the pull request Workspace is enabled.")
  }

  function isModuleBinding(index: number): boolean {
    return visibleDeclaration(index) === undefined
      && !callbackParameters.some(scope => index >= scope.start && index < scope.end && scope.names.has(tokens[index]))
  }

  function hasChannelContinuation(index: number): boolean {
    const token = tokens[index]
    if (["(", "<", ".", "[", "?"].includes(token)) return true
    if (token !== "!") return false
    return ![undefined, ",", "}", ")", "]", ";"].includes(tokens[index + 1])
  }

  function channelOwnsWorkspace(channel: number, channelId?: string): boolean {
    let channelOptions = resolveReference(channel, new Set(), true)
    const moduleNamespace = moduleNamespaces.get(tokens[channelOptions])
    if (moduleNamespace && isModuleBinding(channelOptions)) {
      const member = memberAccess(channelOptions)
      if (!member || hasLogicalOperator(channelOptions) || hasChannelContinuation(member.end) || mutatedBindings.has(tokens[channelOptions]!)) throw opaqueChannelError()
      return importedChannelOwnsWorkspace(moduleNamespace, member.name, channelId)
    }
    const moduleImport = moduleImports.get(tokens[channelOptions])
    const namespaceMember = memberAccess(channelOptions)
    if (moduleImport && namespaceMember && isModuleBinding(channelOptions)
      && !mutatedBindings.has(tokens[channelOptions]!)) {
      if (hasLogicalOperator(channelOptions) || hasChannelContinuation(namespaceMember.end)) throw opaqueChannelError()
      return importedChannelOwnsWorkspace(moduleImport.specifier, moduleImport.name, channelId, namespaceMember.name)
    }
    if (moduleImport && isModuleBinding(channelOptions) && !hasChannelContinuation(channelOptions + 1)) {
      if (mutatedBindings.has(tokens[channelOptions]!)) throw opaqueChannelError()
      return importedChannelOwnsWorkspace(moduleImport.specifier, moduleImport.name, channelId)
    }
    const helper = channelHelper(channelOptions)
    if (helper !== undefined) return channelHelperOwnsWorkspace(helper.call, helper.helper)
    const channelCall = factoryCall(channelOptions, "defineChannel")
    if (channelCall !== undefined) {
      // defineChannel(kind, options) contributes the options of this invocation.
      let depth = 0
      let hasOptions = false
      for (let i = channelCall + 1; i < tokens.length; i++) {
        if (depth === 0 && tokens[i] === ")") break
        if (depth === 0 && tokens[i] === ",") { channelOptions = i + 1; hasOptions = true; break }
        if (["{", "(", "["].includes(tokens[i])) depth++
        else if (["}", ")", "]"].includes(tokens[i])) depth--
      }
      if (!hasOptions || undefinedValue(channelOptions) || tokens[channelOptions] === ")") return false
    }
    channelOptions = resolveReference(channelOptions, new Set(), true)
    let opaque = false
    const channelProperties = properties(channelOptions, true, false, () => { opaque = true })
    if (opaque) throw opaqueChannelError()
    if (tokens[channelOptions] !== "{" || tokens[channelOptions - 1] === ")") throw opaqueChannelError()
    const capabilities = channelProperties.get("capabilities")
    if (capabilities !== undefined && capabilityOwnsWorkspace(capabilities)) return true
    const pullRequest = channelProperties.get("pullRequest")
    if (channelId !== "github" || channelCall !== undefined || pullRequest === undefined) return false
    const kind = channelProperties.get("kind")
    if (kind !== undefined) {
      const value = resolveReference(kind, new Set(), true)
      if (/^["'`]/.test(tokens[value] ?? "")) return false
      throw opaqueChannelError()
    }
    return pullRequestOwnsWorkspace(pullRequest)
  }

  // Mirrors the Workspace ownership of the first-party Channel helpers:
  // `capabilities` for every helper and the pull request Workspace for github().
  function channelHelperOwnsWorkspace(call: number, helper: string): boolean {
    const argument = call + 1
    if (tokens[argument] === ")") return false
    if (tokens[argument] === ".") throw opaqueChannelError()
    if (undefinedValue(argument)) return false
    let options = resolveReference(argument, new Set(), true)
    const frozenOptions = new Set<number>()
    while (globalObjectReference(options) && tokens[options + 1] === "." && tokens[options + 2] === "freeze" && tokens[options + 3] === "(") {
      if (frozenOptions.has(options)) throw opaqueChannelError()
      frozenOptions.add(options)
      options = resolveReference(options + 4, new Set(), true)
    }
    if (tokens[options] !== "{" || tokens[options - 1] === ")") throw opaqueChannelError()
    let opaque = false
    const settings = properties(options, true, false, () => { opaque = true })
    // An opaque spread can supply capabilities or pullRequest.
    if (opaque) throw opaqueChannelError()
    const capabilities = settings.get("capabilities")
    if (capabilities !== undefined && capabilityOwnsWorkspace(capabilities)) return true
    const pullRequest = settings.get("pullRequest")
    return helper === "github" && pullRequest !== undefined && pullRequestOwnsWorkspace(pullRequest)
  }

  // github() adds the pull request Workspace unless pullRequest is disabled or
  // pullRequest.workspace is false.
  function pullRequestOwnsWorkspace(index: number, seen = new Set<number>()): boolean {
    if (seen.has(index)) throw pullRequestError()
    seen.add(index)
    const staticBranch = staticConditionalBranch(index)
    if (staticBranch !== undefined) return pullRequestOwnsWorkspace(staticBranch, new Set(seen))
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => pullRequestOwnsWorkspace(branch, new Set(seen)))
    if (hasLogicalOperator(index)) throw pullRequestError()
    const value = resolveReference(index, new Set(), true)
    if (value !== index) return pullRequestOwnsWorkspace(value, seen)
    if (tokens[value] === "false" || undefinedValue(value)) return false
    if (tokens[value] === "true") return true
    if (tokens[value] !== "{") throw pullRequestError()
    let opaque = false
    let prototype = false
    const workspace = properties(value, false, false, () => { opaque = true }, () => { prototype = true }).get("workspace")
    if (prototype) throw pullRequestError()
    if (workspace === undefined) {
      if (opaque) throw pullRequestError()
      return true
    }
    return pullRequestWorkspaceEnabled(workspace)
  }

  function pullRequestWorkspaceEnabled(index: number, seen = new Set<number>()): boolean {
    if (seen.has(index)) throw pullRequestError()
    seen.add(index)
    const staticBranch = staticConditionalBranch(index)
    if (staticBranch !== undefined) return pullRequestWorkspaceEnabled(staticBranch, new Set(seen))
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => pullRequestWorkspaceEnabled(branch, new Set(seen)))
    if (hasLogicalOperator(index)) throw pullRequestError()
    const value = resolveReference(index, new Set(), true)
    if (value !== index) return pullRequestWorkspaceEnabled(value, seen)
    if (tokens[value] === "false") return false
    if (tokens[value] === "true" || tokens[value] === "{" || undefinedValue(value)) return true
    throw pullRequestError()
  }

  function importedModule(specifier: string) {
    const module = resolveChannelModule(file, specifier)
    if (module === undefined || modules.has(module.file)) throw importedChannelError()
    return inspectAgentModule(module.source, module.file, new Set([...modules, module.file]))
  }

  function importedChannelOwnsWorkspace(specifier: string, name: string, channelId?: string, member?: string): boolean {
    return importedModule(specifier).exportedChannelOwnsWorkspace(name, channelId, member)
  }

  // Returns undefined when this module does not export the name.
  function exportOwnsWorkspace(name: string, channelId?: string, member?: string): boolean | undefined {
    const namespace = moduleNamespaces.get(name)
    if (namespace !== undefined) return importedModule(namespace).exportOwnsWorkspace(member ?? "default", channelId)
    const reExport = reExports.get(name)
    if (reExport !== undefined) return importedChannelOwnsWorkspace(reExport.specifier, reExport.name, channelId, member)
    if (opaqueExports.has(name)) throw opaqueChannelError()
    const index = name === "default" ? exported : namedExports.get(name)
    if (index !== undefined) {
      if (member !== undefined) throw opaqueChannelError()
      return channelOwnsWorkspace(index, channelId)
    }
    // `export *` never re-exports the default binding.
    if (name === "default") return
    for (const specifier of starExports) {
      const owns = importedModule(specifier).exportOwnsWorkspace(name, channelId, member)
      if (owns !== undefined) return owns
    }
  }

  // Returns [name, initializer, binding] tuples for variable and resource
  // declarations. Declarators without an initializer are skipped.
  function declarators(keyword: number): [string, number, number][] {
    const result: [string, number, number][] = []
    let name = keyword + 1
    let initializer: number | undefined
    let depth = 0
    for (let k = keyword + 1; k < tokens.length; k++) {
      const token = tokens[k]
      if (initializer === undefined && tokens[name + 1] === ":" && token === "<") {
        k = skipTypeArguments(k) - 1
        continue
      }
      if (depth === 0) {
        if (token === ";" || (k > keyword + 1 && (startsStatement(k)
          || (lineBreaks.has(k) && (declarationKeyword(k) || ["export", "import", "function", "class"].includes(token)))))) break
        if (token === "=" && initializer === undefined && tokens[k + 1] !== ">") {
          initializer = k + 1
          if (isIdentifier(tokens[name] ?? "")) result.push([tokens[name]!, initializer, name])
        }
        // A comma separates declarators after an initializer or an uninitialized
        // binding, and only before a binding. This skips type argument commas.
        if (token === "," && (initializer !== undefined || k === name + 1 || tokens[name + 1] === ":")
          && isIdentifier(tokens[k + 1] ?? "") && ["=", ":", ",", ";"].includes(tokens[k + 2] ?? ";")) {
          name = k + 1
          initializer = undefined
        }
      }
      if (["{", "(", "["].includes(token)) depth++
      else if (["}", ")", "]"].includes(token) && --depth < 0) break
    }
    return result
  }

  function ownsWorkspace(index: number, seen = new Set<number>(), inspectParent = false): boolean {
    index = resolveReference(index, new Set(), true)
    if (seen.has(index)) return false
    seen.add(index)
    const branches = conditionalBranches(index)
    if (branches) return branches.some(branch => ownsWorkspace(branch, new Set(seen), inspectParent))
    // Extension tuples inherit ownership from their parent, not their option block.
    if (inspectParent && tokens[index] === "[") {
      const parent = tokens[index + 1] === "." && tokens[index + 2] === "." && tokens[index + 3] === "."
        ? index + 4
        : index + 1
      return ownsWorkspace(parent, seen, true)
    }
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
    if (workspace !== undefined && !undefinedValue(workspace)) {
      function workspaceOwnsDefinition(index: number): boolean {
        const value = resolveReference(index, new Set(), true)
        const branches = conditionalBranches(value)
        if (branches) return branches.some(workspaceOwnsDefinition)
        if (tokens[value] === "{") {
          const name = properties(value, false, true).get("name")
          if (name === undefined) return true
          const nameValue = resolveReference(name)
          if (undefinedValue(nameValue)) return true
          if (/^["'`]/.test(tokens[nameValue] ?? "")) return false
          throw new Error("[vitehub] Agent Workspace discovery cannot inspect a dynamic Workspace name. Use a statically known string reference or workspace: {} ownership marker.")
        }
        if (undefinedValue(value) || /^["'`]/.test(tokens[value] ?? "")) return false
        // A dynamic member may resolve to either a named reference or owned
        // storage. Require an explicit contract instead of guessing ownership.
        const optionBinding = callbackParameters.some(scope => value >= scope.start && value < scope.end && scope.names.has(tokens[value]))
        let suffix = value + 1
        while (tokens[suffix] === "!") suffix++
        if (optionBinding || ["(", "<", ".", "["].includes(tokens[suffix]) || (tokens[suffix] === "?" && tokens[suffix + 1] === ".")) {
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
      let opaque = false
      let owns = false
      const channelMap = resolveReference(channels)
      const callbackChannelMap = tokens[channelMap] !== "{"
        && callbackParameters.some(scope => channelMap >= scope.start && channelMap < scope.end && scope.names.has(tokens[channelMap]))
      const onOpaqueChannelMap = callbackChannelMap ? undefined : () => { opaque = true }
      for (const [channelId, channel] of properties(channels, true, false, onOpaqueChannelMap)) {
        if (channelOwnsWorkspace(channel, channelId)) owns = true
      }
      if (opaque) throw opaqueChannelError()
      if (owns) return true
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
      let returnGroup = { depth: Number.POSITIVE_INFINITY }
      const returnGroups = new Map<number, { depth: number }>()
      const returnedDefinitions: number[] = []
      let callbackDepth = 0
      let returnExpression = false
      let returnExpressionDepth = -1
      const body = tokens[bodyStart] === ">" ? bodyStart + 1 : bodyStart
      const callbackScope = variableScope(tokens[body] === "{" ? body + 1 : body)
      for (let i = bodyStart; i < callbackEnd; i++) {
        const token = tokens[i]
        if (returnExpression && callbackDepth === returnExpressionDepth && startsStatement(i)) returnExpression = false
        const inCallbackScope = variableScope(i) === callbackScope
        const reference = resolveReference(i, new Set(), true)
        const callEnd = memberCallEnd(reference)
        const opaqueCall = isIdentifier(tokens[reference] ?? "") && tokens[callEnd] === "("
          && conditionalBranches(reference) === undefined
        const opaqueMember = isIdentifier(tokens[reference] ?? "")
          && conditionalBranches(reference) === undefined
          && ([".", "["].includes(tokens[reference + 1]) || (tokens[reference + 1] === "?" && tokens[reference + 2] === "."))
        if (inCallbackScope && (factoryCall(reference) !== undefined || opaqueCall || opaqueMember)) {
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
            tokens[expressionStart - 1] === "return" ||
            ((returnExpression || tokens[body] !== "{") && ["?", ":"].includes(tokens[expressionStart - 1]))
          if (returned) {
            returnGroup.depth = Math.min(returnGroup.depth, expressionDepth)
            returnGroups.set(i, returnGroup)
            returnedDefinition = i
            // Keep every call in the returned expression. Conditional branches
            // may be nested in parentheses and therefore have different token
            // depths, but each remains a possible callback result.
            returnedDefinitions.push(i)
          } else if (!returned && returnedDefinition < 0 && callbackDepth < callbackDefinitionDepth) {
            callbackDefinition = i
            callbackDefinitionDepth = callbackDepth
          }
        }
        if (token === "return" && inCallbackScope) {
          returnExpression = true
          returnExpressionDepth = callbackDepth
          // Each return has its own expression depth. Control-flow blocks may
          // nest an early return deeper than the callback's final return.
          returnGroup = { depth: Number.POSITIVE_INFINITY }
        }
        // Declarations also end a preceding semicolon-free return statement.
        else if (callbackDepth === returnExpressionDepth && (token === ";" || declarationKeyword(i))) returnExpression = false
        if (["{", "(", "["].includes(token)) callbackDepth++
        else if (["}", ")", "]"].includes(token)) callbackDepth--
        if (callbackDepth < returnExpressionDepth) returnExpression = false
      }
      // Exclude nested settings within each returned expression independently.
      // Function scope checks above exclude returns belonging to nested helpers.
      const returnedCandidates = returnedDefinitions.filter((index) => {
        const returnedDefinitionDepth = returnGroups.get(index)!.depth
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
    const selectionIndex = resolveReference(preset)
    const selection = tokens[selectionIndex]
    if (!/^["'`]/.test(selection) || (selection.startsWith("`") && selection.includes("${"))
      || hasLogicalOperator(preset) || hasLogicalOperator(selectionIndex) || conditionalBranches(preset)
      || ["+", "?", ".", "[", "("].includes(tokens[selectionIndex + 1])) {
      throw new Error("[vitehub] Agent Workspace discovery cannot inspect a dynamic preset selection. Use a statically known preset name or add an explicit Workspace ownership marker.")
    }
    const entry = properties(registry, false, true).get(propertyName(selection))
    return entry !== undefined && ownsWorkspace(entry, seen, true)
  }

  return {
    agentOwnsWorkspace(): boolean {
      // The default export owns the folder; helper definitions and unselected presets do not.
      if (exported !== undefined) return ownsWorkspace(exported)
      return tokens.some((token, index) => token === "defineAgent" && ownsWorkspace(index))
    },
    exportOwnsWorkspace,
    exportedChannelOwnsWorkspace(name: string, channelId?: string, member?: string): boolean {
      const owns = exportOwnsWorkspace(name, channelId, member)
      if (owns === undefined) throw importedChannelError()
      return owns
    },
  }
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
      const workspace = isWorkspaceAgentDefinition(source, file)
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
