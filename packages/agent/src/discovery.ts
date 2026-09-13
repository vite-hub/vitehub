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
            const moduleIndex = tokens.indexOf("from", j + 2)
            const moduleToken = moduleIndex >= 0
              ? tokens[moduleIndex + 1]
              : tokens.slice(j + 2).find(candidate => /^['"`]/.test(candidate))
            const moduleName = moduleToken?.slice(1, -1)
            if (moduleName === "@vite-hub/agent" || moduleName === "vite-hub/agent") {
              importedNamespaces.add(tokens[j + 1])
            }
            continue
          }
          if (!sawFrom && /^['"`]/.test(token)) { i = j; break }
          if (sawFrom) {
            if (/^["'`]/.test(token)) { i = j; break }
            continue
          }
          if (/^[A-Za-z_$]/.test(token) && !["from", "as", "type"].includes(token)) imported.add(token)
        }
      }
      if (["const", "let", "var"].includes(tokens[i])) {
        const name = tokens[i + 1]
        let equals = i + 2
        while (equals < tokens.length && tokens[equals] !== "=" && tokens[equals] !== ";" && tokens[equals] !== ",") equals++
        if (name && tokens[equals] === "=") declarations.set(name, equals + 1)
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

  function resolveReference(index: number, seen = new Set<number>()): number {
    while (tokens[index] === "(") index++
    if (seen.has(index)) return index
    seen.add(index)
    const reference = declarations.get(tokens[index])
    return reference === undefined ? index : resolveReference(reference, seen)
  }

  function propertyName(token: string): string {
    return /^["'`]/.test(token) ? token.slice(1, -1) : token
  }

  function properties(index: number): Map<string, number> {
    const result = new Map<string, number>()
    index = resolveReference(index)
    if (tokens[index] !== "{") return result
    let depth = 0
    let atProperty = true
    for (let i = index + 1; i < tokens.length; i++) {
      const token = tokens[i]
      if (depth === 0 && token === "}") break
      if (depth === 0 && atProperty) {
        if (token === "." && tokens[i + 1] === "." && tokens[i + 2] === ".") {
          const spread = properties(i + 3)
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
          if (bracketDepth === 0 && tokens[close] === ":") {
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
              if (!value || !/^["'`]/.test(value)) { valid = false; break }
              literalParts.push(propertyName(value))
              if (p + 1 < expression.length && expression[p + 1] !== "+") { valid = false; break }
            }
            if (valid && literalParts.length) key = literalParts.join("")
            if (key !== undefined) result.set(key, close + 1)
            i = close
            atProperty = false
          }
        } else if (tokens[i + 1] === ":") result.set(propertyName(token), i + 2)
        else if ([",", "}"].includes(tokens[i + 1])) result.set(propertyName(token), i)
        atProperty = false
      }
      if (depth === 0 && token === ",") atProperty = true
      if (["{", "(", "["].includes(token)) depth++
      if (["}", ")", "]"].includes(token)) depth--
    }
    return result
  }

  function ownsWorkspace(index: number, seen = new Set<number>()): boolean {
    index = resolveReference(index)
    while (tokens[index] === "(") index++
    if (seen.has(index)) return false
    seen.add(index)
    if (tokens[index] !== "defineAgent") {
      if (!(tokens[index + 1] === "." && tokens[index + 2] === "defineAgent" && importedNamespaces.has(tokens[index]))) return false
      index += 2
    }
    let call = index + 1
    if (tokens[call] === "<") {
      let genericDepth = 0
      do {
        if (tokens[call] === "<") genericDepth++
        if (tokens[call] === ">") genericDepth--
        call++
      } while (call < tokens.length && genericDepth > 0)
    }
    if (tokens[call] !== "(") return false
    const options = properties(call + 1)
    const workspace = options.get("workspace")
    if (workspace !== undefined) {
      const value = resolveReference(workspace)
      if (tokens[value] === "{") {
        // A `{ name: "shared" }` value is a Workspace reference, not an
        // owned Workspace definition. Runtime applies the same distinction.
        const workspaceProperties = properties(value)
        const name = workspaceProperties.get("name")
        if (name !== undefined && /^(["\'`])/.test(tokens[resolveReference(name)] ?? "")) return false
        return true
      }
      if (tokens[value] === "defineWorkspace") return true
      // Imported Workspace configurations cannot be resolved to a local
      // declaration, but they are valid runtime values and therefore imply
      // that this Agent owns a Workspace.
      if (imported.has(tokens[value])) return true
      if (/^["'`]/.test(tokens[value] ?? "")) return false
      // An explicit Workspace value (including a string reference or an
      // unresolved imported binding) overrides any preset Workspace. Do not
      // fall through to preset lookup when the child supplied `workspace`.
      return true
    }
    const inherited = options.get("extends")
    if (inherited !== undefined && ownsWorkspace(inherited, seen)) return true
    const preset = options.get("preset")
    const registry = options.get("presets")
    if (preset === undefined || registry === undefined) return false
    const selection = tokens[resolveReference(preset)]
    if (!/^["'`]/.test(selection)) return false
    const entry = properties(registry).get(propertyName(selection))
    return entry !== undefined && ownsWorkspace(entry, seen)
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
