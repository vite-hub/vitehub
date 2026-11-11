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
import { argumentExpression, findProperty, moduleTokens, scanModule, staticValue, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"

import type { CallExpression, Expression, Node, ObjectExpression, ScannedModule } from "@vite-hub/internal/build/scan-module"

import type { DiscoveredAgentDefinition } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import { hasAgentModuleTrait } from "./internal/agent-module-traits.ts"

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

/**
 * Splits Agent source into tokens. Literals stay single tokens so their punctuation cannot change object depth, and
 * identifier escapes are decoded because they name the same bindings at runtime.
 */
export function tokenizeAgentSource(source: string, file?: string): { tokens: string[], lineBreaks: Set<number> } {
  return moduleTokens(scanModule(source, file))
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

/** Whether an Agent module statically imports a package subpath that declares the `processHost` trait. */
export function usesProcessHostPreset(source: string, file: string): boolean {
  const { tokens } = tokenizeAgentSource(source)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "import" || tokens[index + 1] === "(") continue
    for (let next = index + 1; next < tokens.length && tokens[next] !== ";" && tokens[next] !== "import"; next++) {
      if (!/^['"`]/.test(tokens[next] ?? "")) continue
      if (hasAgentModuleTrait(moduleSpecifier(tokens[next]), file, "processHost")) return true
      break
    }
  }
  return false
}

/** Discovered Agents whose definitions use a process host preset, by discovered name. */
export function discoverProcessHostAgentNames(definitions: readonly DiscoveredAgentDefinition[]): string[] {
  return definitions.filter(definition => usesProcessHostPreset(readFileSync(definition.handler, "utf8"), definition.handler)).map(definition => definition.name).sort()
}

const agentEntries = new Set(["@vite-hub/agent", "vite-hub/agent"])

function exportName(node: { type: "Identifier", name: string } | { type: "Literal", value: unknown }): string | undefined {
  return node.type === "Identifier" ? node.name : typeof node.value === "string" ? node.value : undefined
}

/**
 * A binding that discovery can follow without running the module: a `const`, or a `let` or `var` that no assignment
 * changes, with the scope of its initializer. `factory` and `namespace` are imports from the Agent entry. Other
 * bindings, such as parameters, functions, and other imports, are `opaque`.
 */
type Binding =
  | { kind: "value", init: Expression, scope: Scope }
  | { kind: "factory" | "namespace" | "opaque" }

interface Scope {
  bindings: Map<string, Binding>
  parent?: Scope
}

/** The names that a binding pattern declares, such as `a` and `c` in `{ a, b: [c] }`. */
function patternNames(pattern: Node | null): string[] {
  if (!pattern) return []
  switch (pattern.type) {
    case "Identifier": return [pattern.name]
    case "ObjectPattern": return pattern.properties.flatMap(property => patternNames(property.type === "RestElement" ? property.argument : property.value))
    case "ArrayPattern": return pattern.elements.flatMap(element => patternNames(element))
    case "AssignmentPattern": return patternNames(pattern.left)
    case "RestElement": return patternNames(pattern.argument)
    case "TSParameterProperty": return patternNames(pattern.parameter)
    default: return []
  }
}

/** The names that a statement declares in its block. */
function statementNames(statement: Node): string[] {
  if (statement.type === "VariableDeclaration") return statement.declarations.flatMap(declarator => patternNames(declarator.id))
  if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) return [statement.id.name]
  return []
}

/** The names that an assignment changes anywhere in the module. Discovery does not follow a `let` or `var` with such a name. */
function assignedNames(program: Node): Set<string> {
  const names = new Set<string>()
  walk(program, (node) => {
    const targets = node.type === "AssignmentExpression" ? patternNames(node.left)
      : node.type === "UpdateExpression" ? patternNames(node.argument)
        : (node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration" ? patternNames(node.left)
            : []
    for (const name of targets) names.add(name)
  })
  return names
}

/** Adds the bindings that a statement declares to its scope. */
function declareBindings(scope: Scope, statement: Node, assigned: ReadonlySet<string>): void {
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    if (statement.declaration) declareBindings(scope, statement.declaration, assigned)
    return
  }
  if (statement.type === "ImportDeclaration") {
    if (statement.importKind === "type") return
    const agentEntry = agentEntries.has(statement.source.value)
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue
      const kind = !agentEntry ? "opaque"
        : specifier.type === "ImportNamespaceSpecifier" ? "namespace"
          : specifier.type === "ImportSpecifier" && exportName(specifier.imported) === "defineAgent" ? "factory" : "opaque"
      scope.bindings.set(specifier.local.name, { kind })
    }
    return
  }
  if (statement.type === "VariableDeclaration") {
    const reassignable = statement.kind === "let" || statement.kind === "var"
    for (const declarator of statement.declarations) {
      if (declarator.id.type === "Identifier" && declarator.init && !(reassignable && assigned.has(declarator.id.name))) {
        scope.bindings.set(declarator.id.name, { kind: "value", init: declarator.init, scope })
      }
      else for (const name of patternNames(declarator.id)) scope.bindings.set(name, { kind: "opaque" })
    }
    return
  }
  for (const name of statementNames(statement)) scope.bindings.set(name, { kind: "opaque" })
}

/** The scope that a function, block, loop, or catch clause opens for the code inside it. Undefined for other nodes. */
function openScope(node: Node, parent: Scope, assigned: ReadonlySet<string>): Scope | undefined {
  const scope: Scope = { bindings: new Map(), parent }
  let names: string[]
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": names = node.params.flatMap(parameter => patternNames(parameter)); break
    case "BlockStatement":
    case "StaticBlock":
      for (const statement of node.body) declareBindings(scope, statement, assigned)
      return scope
    case "ForStatement": names = node.init ? statementNames(node.init) : []; break
    case "ForInStatement":
    case "ForOfStatement": names = statementNames(node.left); break
    case "CatchClause": names = patternNames(node.param); break
    default: return
  }
  for (const name of names) scope.bindings.set(name, { kind: "opaque" })
  return scope
}

function lookupBinding(scope: Scope | undefined, name: string): Binding | undefined {
  for (; scope; scope = scope.parent) {
    const binding = scope.bindings.get(name)
    if (binding) return binding
  }
}

/** Follows an expression through the bindings that hold it, such as `options` in `const options = {}`. */
function resolveValue(node: Expression, scope: Scope, seen = new Set<Binding>()): { node: Expression, scope: Scope } {
  node = unwrapExpression(node)
  const binding = node.type === "Identifier" ? lookupBinding(scope, node.name) : undefined
  if (binding?.kind !== "value" || seen.has(binding)) return { node, scope }
  seen.add(binding)
  return resolveValue(binding.init, binding.scope, seen)
}

/**
 * True for `defineAgent` from the Agent entry, a member of its namespace, a binding that holds either, or the bare name
 * when no binding declares it (an auto-import). A local binding with the same name, such as a parameter, hides it.
 */
function isAgentFactory(callee: Expression, scope: Scope): boolean {
  const { node, scope: at } = resolveValue(callee, scope)
  if (node.type === "Identifier") {
    const binding = lookupBinding(at, node.name)
    return binding ? binding.kind === "factory" : node.name === "defineAgent"
  }
  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "defineAgent"
    && node.object.type === "Identifier" && lookupBinding(at, node.object.name)?.kind === "namespace"
}

interface AgentFactoryCall {
  call: CallExpression
  /** The scope that the call reads its bindings from. */
  scope: Scope
}

interface AgentModule {
  calls: AgentFactoryCall[]
  module: ScannedModule
  scope: Scope
}

/** The `defineAgent()` calls of a module, in source order. */
function readAgentModule(source: string, file: string): AgentModule {
  const module = scanModule(source, file)
  const assigned = assignedNames(module.program)
  const scope: Scope = { bindings: new Map() }
  for (const statement of module.program.body) declareBindings(scope, statement, assigned)
  const calls: AgentFactoryCall[] = []
  const visit = (node: Node, outer: Scope): void => {
    const inner = openScope(node, outer, assigned) ?? outer
    if (node.type === "CallExpression" && node.callee.type !== "Super" && isAgentFactory(node.callee, inner)) calls.push({ call: node, scope: inner })
    walk(node, (child) => {
      if (child === node) return
      visit(child, inner)
      return false
    })
  }
  visit(module.program, scope)
  return { calls, module, scope }
}

/** The options object of a `defineAgent()` call, inline or through a binding, with the scope that it reads bindings from. */
function agentOptions({ call, scope }: AgentFactoryCall): { node: ObjectExpression, scope: Scope } | undefined {
  const argument = argumentExpression(call.arguments[0])
  if (!argument) return
  const { node, scope: at } = resolveValue(argument, scope)
  return node.type === "ObjectExpression" ? { node, scope: at } : undefined
}

/**
 * The `defineAgent()` calls that the module can export as default: the call itself, a binding that holds it, or either
 * branch of a conditional. Undefined when the module has no default export.
 */
function defaultAgentCalls({ calls, module, scope }: AgentModule): AgentFactoryCall[] | undefined {
  let exported: Expression | undefined
  for (const statement of module.program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration
      if (declaration.type !== "FunctionDeclaration" && declaration.type !== "ClassDeclaration" && declaration.type !== "TSInterfaceDeclaration") exported = unwrapExpression(declaration)
    }
    else if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (exportName(specifier.exported) === "default" && specifier.local.type === "Identifier") exported = specifier.local
      }
    }
  }
  const results = (expression: Expression, at: Scope, seen: Set<Binding>): AgentFactoryCall[] => {
    const { node, scope: from } = resolveValue(expression, at, seen)
    if (node.type === "ConditionalExpression") return [...results(node.consequent, from, new Set(seen)), ...results(node.alternate, from, new Set(seen))]
    return calls.filter(entry => entry.call === node)
  }
  return exported && results(exported, scope, new Set())
}

/**
 * True when Agent options declare a Workspace that the Agent owns: a `workspace` key whose value is not `undefined`,
 * `null`, a Workspace name, or a `{ name }` reference to a shared Workspace. Bindings are followed for each value.
 */
function declaresOwnedWorkspace(options: ObjectExpression, scope: Scope): boolean {
  const property = findProperty(options, "workspace")?.value
  if (property === undefined) return false
  const workspace = resolveValue(property, scope)
  const value = staticValue(workspace.node)
  if (value === undefined || value === null || typeof value === "string") return false
  if (workspace.node.type !== "ObjectExpression") return true
  const name = findProperty(workspace.node, "name")?.value
  return name === undefined || typeof staticValue(resolveValue(name, workspace.scope).node) !== "string"
}

/**
 * A folder Agent owns a Workspace when its `defineAgent()` options have a `workspace` key. Discovery reads the key
 * without running the module. The default export decides; a module without one is read through all its calls.
 */
function isWorkspaceAgentDefinition(source: string, file: string): boolean {
  const agentModule = readAgentModule(source, file)
  return (defaultAgentCalls(agentModule) ?? agentModule.calls).some((call) => {
    const options = agentOptions(call)
    return options !== undefined && declaresOwnedWorkspace(options.node, options.scope)
  })
}

/** The start offsets of the options objects of the `defineAgent()` calls in a module. */
export function discoverAgentOptionsStarts(source: string, file: string): Set<number> {
  return new Set(readAgentModule(source, file).calls.flatMap(call => agentOptions(call)?.node.start ?? []))
}

/**
 * True for a folder Agent, `agents/<name>/agent.ts` or `agents/<name>/index.ts`. Only a folder Agent can get its
 * Workspace from discovery.
 */
export function isFolderAgentDefinition(definition: Pick<DiscoveredAgentDefinition, "handler" | "name" | "source">): boolean {
  const file = basename(definition.handler)
  return definition.source !== "vite-suffix"
    && (folderAgentPattern.test(file) || indexDefinitionPattern.test(file))
    && dirname(definition.handler).replace(/\\/g, "/").endsWith(`/${definition.name}`)
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
