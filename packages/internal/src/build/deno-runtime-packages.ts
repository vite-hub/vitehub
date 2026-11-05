import { createRuntimePackageResolver } from "./runtime-package-resolution.ts"
import { randomUUID } from "node:crypto"
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { Plugin } from "esbuild"
import { satisfies, validRange } from "semver"

import { bundleEsmEntry, type ViteAlias } from "./esbuild.ts"
import { publishProviderSourcesToDeploymentOutputs } from "./provider-output-sources.ts"
import { scanModule, walk } from "./scan-module.ts"
import type { CallExpression, Expression, NewExpression, Node, ScannedModule } from "./scan-module.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

const resolvePackageJson = createRuntimePackageResolver(source => parseRuntimePackageJson(source).name)

const builtinModuleNames = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const activeDenoDeploymentStages = new Set<string>()
const denoRuntimeTargets = [
  { cpu: "arm64", libc: "glibc", os: "linux" },
  { cpu: "x64", libc: "glibc", os: "linux" },
] as const

/** The npm packages that the Nitro server bundle needs at runtime, read from the bundler's module graph. */
export interface DenoServerPackages {
  /** Root directories of the packages that the bundler bundled into the server. */
  bundledPackageDirs: string[]
  /** Package imports that the bundler kept external, including literal createRequire calls. */
  externalImports: DenoExternalImport[]
}

export interface DenoExternalImport {
  /** The importing module, createRequire base, or resolved external file to resolve the package from. */
  importer: string
  /** True when a server chunk loads the package with a static `import` statement. */
  required: boolean
  specifier: string
}

interface FinalizeDenoDeploymentOutputOptions {
  alias?: ViteAlias[]
  conditions?: string[]
  define?: Record<string, string>
  extensions?: string[]
  deploymentName?: string
  hasScheduleIntegration?: boolean
  mainFields?: string[]
  outputDir?: string
  preserveSymlinks?: boolean
  rootDir: string
  serverPackages: DenoServerPackages
}

interface ServerBundleChunk {
  code: string
  dynamicImports: string[]
  imports: string[]
  moduleIds: string[]
  modules: Record<string, { code: string | null }>
  type: "chunk"
}

interface ServerModuleGraph {
  getModuleInfo(id: string): { code: string | null, dynamicallyImportedIds: readonly string[], importedIds: readonly string[], isExternal?: boolean } | null
}

/** Records the server bundle's external imports and bundled packages, so the Deno output does not rescan the emitted files. */
export function denoServerPackagesPlugin(onPackages: (packages: DenoServerPackages) => void) {
  return {
    name: "vitehub:deno-server-packages",
    generateBundle(this: ServerModuleGraph, _options: unknown, bundle: Record<string, ServerBundleChunk | { type: "asset" }>): void {
      const chunks = Object.values(bundle).filter((output): output is ServerBundleChunk => output.type === "chunk")
      const staticImports = new Set(chunks.flatMap(chunk => chunk.imports))
      const dynamicImports = new Set(chunks.flatMap(chunk => chunk.dynamicImports))
      const bundledPackageDirs = new Set<string>()
      const externalImports: DenoExternalImport[] = []
      for (const chunk of chunks) {
        externalImports.push(...collectCreateRequirePackageImports(chunk))
      }
      for (const id of new Set(chunks.flatMap(chunk => chunk.moduleIds))) {
        const bundledPackage = packageFromModuleId(id)
        if (bundledPackage) bundledPackageDirs.add(bundledPackage.dir)
        const info = this.getModuleInfo(id)
        const imports = [
          ...(info?.importedIds ?? []).map(importedId => ({ importedId, static: true })),
          ...(info?.dynamicallyImportedIds ?? []).map(importedId => ({ importedId, static: false })),
        ]
        for (const { importedId, static: isStatic } of imports) {
          // Module graph edges can outlive tree-shaken statements, including unused dynamic imports.
          if (!(isStatic ? staticImports : dynamicImports).has(importedId)) continue
          if (packageNameFromSpecifier(importedId)) {
            externalImports.push({ importer: id, required: isStatic, specifier: importedId })
            continue
          }
          // Nitro can keep an external as its resolved file, such as `file:///app/node_modules/sharp/dist/index.mjs`.
          // Resolve the package by name from that file, so pnpm selects the same installation.
          // Rollup marks externals with `isExternal`; Rolldown gives them no code.
          const importedInfo = this.getModuleInfo(importedId)
          if (importedInfo && !importedInfo.isExternal && importedInfo.code !== null) continue
          const file = importedId.startsWith("file:") ? fileURLToPath(importedId) : importedId
          const externalPackage = isAbsolute(file) ? packageFromModuleId(file) : undefined
          if (externalPackage) externalImports.push({ importer: file, required: isStatic, specifier: externalPackage.name })
        }
      }
      onPackages({ bundledPackageDirs: [...bundledPackageDirs].sort(), externalImports })
    },
  }
}

function literalString(node: Node | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0]?.value.cooked ?? undefined : undefined
}

/** Reads a createRequire base without running application code. Unknown bases must not fall back to the source module. */
function createRequireBase(node: Node | undefined, id: string): string | undefined {
  const literal = literalString(node)
  if (literal !== undefined) return literal
  if (node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "url"
    && node.object.type === "MetaProperty" && node.object.meta.name === "import") {
    return id.startsWith("file:") ? id : isAbsolute(id) ? pathToFileURL(id).href : undefined
  }
  if (node?.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "URL") {
    const value = literalString(node.arguments[0])
    const base = createRequireBase(node.arguments[1], id)
    if (value !== undefined) {
      try { return new URL(value, base).href }
      catch { return }
    }
  }
}

function collectCreateRequirePackageImports(chunk: ServerBundleChunk): DenoExternalImport[] {
  const factories = collectImportedCreateRequireFactories(chunk.code)
  const modules = new Map<string, ScannedModule>()
  const renderedModules = chunk.moduleIds.flatMap((id) => {
    const source = chunk.modules[id]?.code
    return source ? [{ id, source }] : []
  })
  const readModule = (id: string, source: string): ScannedModule => {
    let module = modules.get(id)
    if (!module) {
      module = scanModule(source, id)
      modules.set(id, module)
    }
    return module
  }
  // Re-exported factories use the chunk's imported binding. Dynamic node:module
  // imports can also introduce factories in individual rendered modules.
  for (const { id, source } of renderedModules) {
    if (!source.includes("createRequire")) continue
    for (const factory of collectCreateRequireFactories(maskInertImportText(readModule(id, source)))) factories.add(factory)
  }
  if (factories.size === 0) return []

  const factoryBindings = [...factories].map(name => name.split(".")[0]!)
  const mentionsFactory = (source: string): boolean => factoryBindings.some(name => source.includes(name))
  const aliases = new Map<string, string>()
  const imports: DenoExternalImport[] = []
  const factoryBase = (node: Node | undefined, module: ScannedModule): string | undefined => {
    if (node?.type !== "CallExpression") return
    const name = module.source.slice(node.callee.start, node.callee.end).replace(/\s/g, "")
    if (!factories.has(name)) return
    const base = createRequireBase(node.arguments[0], module.file)
    if (base === undefined) return
    try {
      const file = base.startsWith("file:") ? fileURLToPath(base) : base
      if (isAbsolute(file)) return file.endsWith(sep) ? join(file, "__vitehub_require__.js") : file
    }
    catch { return }
  }
  // Bindings are shared across the rendered chunk, but import.meta.url must use
  // the module that constructs the require alias, even when another module calls it.
  for (const { id, source } of renderedModules) {
    if (!mentionsFactory(source)) continue
    const module = readModule(id, source)
    walk(module.program, (node) => {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return
      const base = factoryBase(node.init ?? undefined, module)
      if (base) aliases.set(node.id.name, base)
    })
  }
  const aliasNames = [...aliases.keys()]
  for (const { id, source } of renderedModules) {
    // Alias calls have no graph edges. Parse only fragments mentioning a known
    // factory or alias, and only rendered code so removed calls cannot affect staging.
    if (!mentionsFactory(source) && !aliasNames.some(name => source.includes(name))) continue
    const module = readModule(id, source)
    walk(module.program, (node) => {
      if (node.type !== "CallExpression") return
      // Rolldown may inline a single-use alias as createRequire(base)("package").
      const importer = node.callee.type === "Identifier" ? aliases.get(node.callee.name) : factoryBase(node.callee, module)
      const specifier = literalString(node.arguments[0])
      if (importer && specifier && packageNameFromSpecifier(specifier)) imports.push({ importer, required: false, specifier })
    })
  }
  return imports
}

function packageFromModuleId(id: string): { dir: string, name: string } | undefined {
  if (id.startsWith("\0")) return
  const path = id.replaceAll("\\", "/")
  const index = path.lastIndexOf("/node_modules/")
  if (index < 0) return
  const [first, second] = path.slice(index + "/node_modules/".length).split("/")
  if (!first || (first.startsWith("@") && !second)) return
  const segments = first.startsWith("@") ? [first, second!] : [first]
  return { dir: join(path.slice(0, index), "node_modules", ...segments), name: segments.join("/") }
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("\0")
  )
    return
  if (builtinModuleNames.has(specifier) || specifier.includes(":")) return
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

function isStandaloneCall(source: string, start: number) {
  const immediatePrefix = source[start - 1]
  if (immediatePrefix && /[$_\p{ID_Continue}]/u.test(immediatePrefix))
    return false

  let prefixIndex = start - 1
  while (prefixIndex >= 0 && /\s/.test(source[prefixIndex]!))
    prefixIndex--
  return source[prefixIndex] !== '.' && source[prefixIndex] !== '#'
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const identifierStart = String.raw`(?:[$_\p{ID_Start}]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})`
const identifierContinue = String.raw`(?:[$\u200C\u200D\p{ID_Continue}]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})`
const bindingIdentifier = `${identifierStart}${identifierContinue}*`

function collectImportedCreateRequireFactories(source: string): Set<string> {
  const factories = new Set<string>()
  for (const match of source.matchAll(/(?:^|[;\n])[^\S\r\n]*import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?module["']/gm)) {
    for (const specifier of match[1]!.split(",")) {
      const imported = /^\s*createRequire(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier)
      if (imported) factories.add(imported[1] ?? "createRequire")
    }
  }
  for (const match of source.matchAll(/(?:^|[;\n])[^\S\r\n]*import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*["'](?:node:)?module["']/gm)) {
    factories.add(`${match[1]}.createRequire`)
  }
  return factories
}

function collectCreateRequireFactories(source: string): Set<string> {
  const factories = collectImportedCreateRequireFactories(source)
  for (const match of source.matchAll(/\b(?:const|let|var)\s*\{[^}]*\bcreateRequire(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*(?:__require|require)\s*\(\s*["'](?:node:)?module["']\s*\)/g)) {
    factories.add(match[1] ?? "createRequire")
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:__require|require)\s*\(\s*["'](?:node:)?module["']\s*\)/g)) {
    factories.add(`${match[1]}.createRequire`)
  }
  const dynamicModuleImport = String.raw`await\s+import\s*\(\s*["'](?:node:)?module["']\s*\)`
  const dynamicDestructure = new RegExp(String.raw`\b(?:const|let|var)\s*\{[^}]*\bcreateRequire(?:\s*:\s*(${bindingIdentifier}))?[^}]*\}\s*=\s*${dynamicModuleImport}`, "gu")
  for (const match of source.matchAll(dynamicDestructure)) {
    factories.add(match[1] ?? "createRequire")
  }
  const dynamicNamespace = new RegExp(String.raw`\b(?:const|let|var)\s+(${bindingIdentifier})\s*=\s*${dynamicModuleImport}`, "gu")
  for (const match of source.matchAll(dynamicNamespace)) {
    factories.add(`${match[1]}.createRequire`)
  }
  return factories
}

function collectCreateRequireAliases(source: string): Set<string> {
  const factories = collectCreateRequireFactories(source)
  if (factories.size === 0) return new Set()

  const aliases = new Set<string>()
  const factoryPattern = [...factories].map(escapeRegExp).join("|")
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${factoryPattern})\\s*\\(`, "g")
  for (const match of source.matchAll(declaration)) aliases.add(match[1]!)
  return aliases
}

interface ImportSourceAnalysis {
  createRequireAliases: Set<string>
  executableSource: string
}

function analyzeImportSource(source: string): ImportSourceAnalysis {
  const module = scanModule(source, "output.mjs")
  const createRequireAliases = collectCreateRequireAliases(maskInertImportText(module))
  return {
    createRequireAliases,
    executableSource: maskInertImportText(module, createRequireAliases),
  }
}

function isGuardedConciseArrow(source: string, expressionStart: number, expressionEnd: number): boolean {
  const statementStart = source.lastIndexOf(";", expressionStart - 1) + 1
  const prefix = source.slice(statementStart, expressionStart)
  const arrow = prefix.lastIndexOf("=>")
  if (arrow < 0 || /^\s*\{/.test(prefix.slice(arrow + 2))) return false

  const precedingLines = prefix.slice(arrow + 2).split("\n")
  if (precedingLines.length > 1) {
    const completedLine = precedingLines.at(-2)!.trimEnd()
    const continuationLine = precedingLines.at(-1)!.trimStart()
    if (completedLine
      && !/[([{,.:?+\-*/%&|^!~=<>]$/.test(completedLine)
      && !/^(?:&&|\|\||\?\?|\?\.|[,+\-*/%&|^.:<>=])/.test(continuationLine)
      && delimiterDepth(precedingLines.slice(0, -1).join("\n")) === 0) return false
  }

  let parentheses = 0
  let brackets = 0
  let braces = 0
  for (const character of prefix.slice(arrow + 2)) {
    if (character === "(") parentheses++
    else if (character === ")") parentheses--
    else if (character === "[") brackets++
    else if (character === "]") brackets--
    else if (character === "{") braces++
    else if (character === "}") braces--
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) return false
  }

  return !/^\s*\)+\s*(?:(?:\?\.)?\s*\(|\.\s*(?:call|apply)\s*\()/.test(source.slice(expressionEnd))
}

function delimiterDepth(source: string): number {
  let depth = 0
  for (const character of source) {
    if (character === "(" || character === "[" || character === "{") depth++
    else if (character === ")" || character === "]" || character === "}") depth--
  }
  return depth
}

interface LiteralDynamicImport {
  literalEnd: number
  specifier: string
  start: number
}

function cookImportSpecifier(source: string): string {
  let cooked = ""
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character !== "\\") {
      cooked += character
      continue
    }
    const escape = source[++index]
    if (escape === undefined) throw internalErrorDiagnostics.INTERNAL_B0009({ message: "Deno output contains an incomplete import escape sequence." })
    if (escape === "\n") continue
    if (escape === "\r") {
      if (source[index + 1] === "\n") index++
      continue
    }
    const simpleEscapes: Record<string, string> = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    }
    const simpleEscape = simpleEscapes[escape]
    if (simpleEscape !== undefined) {
      if (escape === "0" && /\d/.test(source[index + 1] || "")) {
        throw internalErrorDiagnostics.INTERNAL_B0010({ message: "Deno output contains an unsupported legacy octal import escape sequence." })
      }
      cooked += simpleEscape
      continue
    }
    if (escape === "x") {
      const digits = source.slice(index + 1, index + 3)
      if (!/^[\dA-Fa-f]{2}$/.test(digits)) throw internalErrorDiagnostics.INTERNAL_B0011({ message: "Deno output contains an invalid hexadecimal import escape sequence." })
      cooked += String.fromCharCode(Number.parseInt(digits, 16))
      index += 2
      continue
    }
    if (escape === "u") {
      if (source[index + 1] === "{") {
        const end = source.indexOf("}", index + 2)
        const digits = end === -1 ? "" : source.slice(index + 2, end)
        const codePoint = /^[\dA-Fa-f]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : Number.NaN
        if (!Number.isSafeInteger(codePoint) || codePoint > 0x10FFFF) {
          throw internalErrorDiagnostics.INTERNAL_B0012({ message: "Deno output contains an invalid Unicode import escape sequence." })
        }
        cooked += String.fromCodePoint(codePoint)
        index = end
        continue
      }
      const digits = source.slice(index + 1, index + 5)
      if (!/^[\dA-Fa-f]{4}$/.test(digits)) throw internalErrorDiagnostics.INTERNAL_B0013({ message: "Deno output contains an invalid Unicode import escape sequence." })
      cooked += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    if (/[1-9]/.test(escape)) throw internalErrorDiagnostics.INTERNAL_B0014({ message: "Deno output contains an unsupported legacy octal import escape sequence." })
    cooked += escape
  }
  return cooked
}

function findLiteralDynamicImports(source: string): LiteralDynamicImport[] {
  const imports: LiteralDynamicImport[] = []
  for (const match of source.matchAll(/(?:^|[^\w$.#])import\s*\(\s*(["'`])/g)) {
    const start = match.index! + match[0].indexOf("import")
    if (!isStandaloneCall(source, start)) continue
    const quote = match[1]!
    const literalStart = match.index! + match[0].length - 1
    let literalEnd = literalStart + 1
    let interpolated = false
    while (literalEnd < source.length) {
      if (source[literalEnd] === "\\") literalEnd += 2
      else if (quote === "`" && source[literalEnd] === "$" && source[literalEnd + 1] === "{") {
        interpolated = true
        break
      }
      else if (source[literalEnd++] === quote) break
    }
    if (interpolated) continue
    if (source[literalEnd - 1] !== quote) continue
    let cursor = literalEnd
    while (/\s/.test(source[cursor] || "")) cursor++
    if (source[cursor] !== ")" && source[cursor] !== ",") continue
    let depth = 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "(") depth++
      else if (source[cursor] === ")") depth--
      cursor++
    }
    if (depth !== 0) continue
    imports.push({
      literalEnd,
      specifier: cookImportSpecifier(source.slice(literalStart + 1, literalEnd - 1)),
      start,
    })
  }
  return imports
}

/** True for a call whose first argument names a module: `require()`, `require.resolve()`, `import.meta.resolve()`, and require aliases. */
function isModuleRequestCall(node: CallExpression | NewExpression, packageCallNames: ReadonlySet<string>): boolean {
  const callee = node.callee
  if (node.type === "NewExpression") return callee.type === "Identifier" && callee.name === "URL"
  const requireName = (value: Expression) => value.type === "Identifier" && (value.name === "require" || value.name === "__require" || packageCallNames.has(value.name))
  if (requireName(callee)) return true
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier" || callee.property.name !== "resolve") return false
  if (requireName(callee.object)) return true
  return callee.object.type === "MetaProperty" && callee.object.meta.name === "import" && callee.object.property.name === "meta"
}

/**
 * Masks comments and literals that cannot name a module, so the import patterns below only match executable code.
 * Module specifiers stay visible. A masked literal ends with `0`, so the code around it still reads an operand.
 */
function maskInertImportText(module: ScannedModule, packageCallNames: ReadonlySet<string> = new Set()): string {
  const { source } = module
  const output = source.split("")
  const mask = (start: number, end: number, operand: boolean) => {
    let last = -1
    for (let index = start; index < end; index++) {
      if (output[index] === "\n") continue
      output[index] = " "
      last = index
    }
    if (operand && last >= 0) output[last] = "0"
  }
  for (const comment of module.comments) mask(comment.start, comment.end, false)
  const specifiers = new Set<Node>()
  walk(module.program, (node) => {
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source) specifiers.add(node.source)
    else if (node.type === "ImportExpression") specifiers.add(node.source)
    else if ((node.type === "CallExpression" || node.type === "NewExpression") && node.arguments[0] && isModuleRequestCall(node, packageCallNames)) specifiers.add(node.arguments[0])
  })
  walk(module.program, (node) => {
    if (node.type === "TemplateLiteral") {
      const staticModuleSpecifier = specifiers.has(node) && node.expressions.length === 0
      // Keep a static module template fully intact so the package regex can
      // read its specifier, including escaped characters.
      if (staticModuleSpecifier) return false
      // Keep the `${` and `}` delimiters and the code between them. The closing backtick reads as an operand.
      // Output parses as JavaScript, whose template element spans hold only the text, without the delimiters.
      for (const quasi of node.quasis) mask(quasi.start, quasi.end, false)
      output[node.start] = " "
      output[node.end - 1] = "0"
      // Dynamic templates still need their expression children visited so
      // nested literals are masked too.
      return undefined
    }
    if (node.type === "Literal" && (typeof node.value === "string" || "regex" in node) && !specifiers.has(node)) mask(node.start, node.end, true)
  })
  return output.join("")
}

function packageImportPlugin(): Plugin {
  const resolvingPackageImport = "vitehubResolvingPackageImport"
  return {
    name: "vitehub-package-imports",
    setup(build) {
      build.onResolve({ filter: /^#/ }, async (args) => {
        if (args.pluginData?.[resolvingPackageImport]) return
        const result = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: { ...args.pluginData, [resolvingPackageImport]: true },
          resolveDir: args.resolveDir,
          with: args.with,
        })
        const pluginData = Object.assign({}, result.pluginData)
        Reflect.deleteProperty(pluginData, resolvingPackageImport)
        return { ...result, pluginData }
      })
    },
  }
}

function runtimePackageResolutionPlugin(
  rootDir: string,
  aliases: ViteAlias[] | undefined,
  packageJsonPaths: Map<string, string>,
  packages: Map<string, RuntimePackage>,
): Plugin {
  return {
    name: "vitehub-deno-runtime-packages",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        const name = packageNameFromSpecifier(args.path)
        if (!name || aliases?.some((alias) => {
          if (!(alias.find instanceof RegExp)) return args.path === alias.find || args.path.startsWith(`${alias.find}/`)
          alias.find.lastIndex = 0
          const matches = alias.find.test(args.path)
          alias.find.lastIndex = 0
          return matches
        })) return
        const fromDir = args.resolveDir || (isAbsolute(args.importer) ? dirname(args.importer) : rootDir)
        const resolver = createRequire(isAbsolute(args.importer) ? args.importer : join(fromDir, "package.json"))
        const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
        const resolvedPackageJsonPath = packageJsonPath && await realpath(packageJsonPath)
        if (resolvedPackageJsonPath) recordRuntimePackageResolution(packageJsonPaths, name, resolvedPackageJsonPath)
        addRuntimePackage(packages, { name, optional: args.kind !== "import-statement", packageJsonPath: resolvedPackageJsonPath })
      })
    },
  }
}

function recordRuntimePackageResolution(packageJsonPaths: Map<string, string>, name: string, packageJsonPath: string): void {
  const existing = packageJsonPaths.get(name)
  if (existing && existing !== packageJsonPath) {
    throw internalErrorDiagnostics.INTERNAL_B0015({ message: `Deno output imports ${JSON.stringify(name)} from multiple package installations. Bundle one version before deployment.` })
  }
  packageJsonPaths.set(name, packageJsonPath)
}

function addRuntimePackage(packages: Map<string, RuntimePackage>, runtimePackage: { name: string, optional: boolean, packageJsonPath?: string }): void {
  const existing = packages.get(runtimePackage.name)
  packages.set(runtimePackage.name, {
    includeOptionalDependencies: true,
    includePeerDependencies: true,
    name: runtimePackage.name,
    optional: (existing?.optional ?? true) && runtimePackage.optional,
    packageJsonPath: existing?.packageJsonPath ?? runtimePackage.packageJsonPath,
  })
}

/** Resolves the server's external imports from their importers, and the Deno-compatible platform binaries of bundled packages. */
async function addServerRuntimePackages(
  serverPackages: DenoServerPackages,
  rootDir: string,
  packageJsonPaths: Map<string, string>,
  packages: Map<string, RuntimePackage>,
): Promise<void> {
  const resolutions = new Map<string, Promise<string | undefined>>()
  const resolveFrom = (name: string, fromDir: string): Promise<string | undefined> => {
    const key = `${fromDir}\0${name}`
    let resolution = resolutions.get(key)
    if (!resolution) {
      resolution = resolvePackageJson(name, createRequire(join(fromDir, "package.json")), fromDir).then(path => path && realpath(path))
      resolutions.set(key, resolution)
    }
    return resolution
  }
  for (const { importer, required, specifier } of serverPackages.externalImports) {
    const name = packageNameFromSpecifier(specifier)
    if (!name) continue
    const packageJsonPath = await resolveFrom(name, isAbsolute(importer) ? dirname(importer) : rootDir)
    if (packageJsonPath) recordRuntimePackageResolution(packageJsonPaths, name, packageJsonPath)
    addRuntimePackage(packages, { name, optional: !required, packageJsonPath })
  }
  // Bundled code loads platform binaries through computed requires, such as libsql's `@libsql/${target}`.
  // Stage only the optional dependencies that declare a platform Deno can run, never the bundled package itself.
  for (const packageDir of serverPackages.bundledPackageDirs) {
    let packageJson: RuntimePackageJson
    try {
      packageJson = parseRuntimePackageJson(await readFile(join(packageDir, "package.json"), "utf8"))
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
      const packageJsonPath = await resolveFrom(name, packageDir)
      if (!packageJsonPath) continue
      const dependency = parseRuntimePackageJson(await readFile(packageJsonPath, "utf8"))
      if (!dependency.os?.length && !dependency.cpu?.length) continue
      if (!supportsDenoRuntime(dependency)) continue
      recordRuntimePackageResolution(packageJsonPaths, name, packageJsonPath)
      addRuntimePackage(packages, { name, optional: true, packageJsonPath })
    }
  }
}

interface RuntimePackage {
  hoistOptionalDependencies?: boolean
  hoistedPeer?: boolean
  includeOptionalDependencies?: boolean
  includePeerDependencies?: boolean
  name: string
  optional?: boolean
  packageJsonPath?: string
  peerRange?: string
  ownsTarget?: boolean
}

interface RuntimePackageJson {
  cpu?: string[]
  dependencies?: Record<string, string>
  libc?: string[]
  name?: string
  optionalDependencies?: Record<string, string>
  os?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  version?: string
}

function parseRuntimePackageJson(source: string): RuntimePackageJson {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw internalErrorDiagnostics.INTERNAL_B0016({ message: "Expected package.json to contain an object." })
  // SAFETY: The preceding runtime validation proves the parsed value is a non-null, non-array object.
  const record = value as Record<string, unknown>
  const stringList = (key: string): string[] | undefined => {
    const property = record[key]
    if (property === undefined) return
    if (typeof property === "string") return [property]
    if (!Array.isArray(property) || !property.every(item => typeof item === "string")) throw internalErrorDiagnostics.INTERNAL_B0017({ message: `Expected package.json ${key} to contain strings.` })
    return property
  }
  const stringRecord = (key: string): Record<string, string> | undefined => {
    const property = record[key]
    if (property === undefined) return
    if (!property || typeof property !== "object" || Array.isArray(property) || !Object.values(property).every(item => typeof item === "string")) throw internalErrorDiagnostics.INTERNAL_B0018({ message: `Expected package.json ${key} to contain string values.` })
    // SAFETY: The preceding validation proves every property value is a string.
    return property as Record<string, string>
  }
  const peerMeta = record.peerDependenciesMeta
  if (peerMeta !== undefined && (!peerMeta || typeof peerMeta !== "object" || Array.isArray(peerMeta))) throw internalErrorDiagnostics.INTERNAL_B0019({ message: "Expected package.json peerDependenciesMeta to contain an object." })
  if (record.name !== undefined && typeof record.name !== "string") throw internalErrorDiagnostics.INTERNAL_B0020({ message: "Expected package.json name to contain a string." })
  return {
    cpu: stringList("cpu"),
    dependencies: stringRecord("dependencies"),
    libc: stringList("libc"),
    name: record.name,
    optionalDependencies: stringRecord("optionalDependencies"),
    os: stringList("os"),
    peerDependencies: stringRecord("peerDependencies"),
    // SAFETY: The parser above establishes that peer dependency metadata is object-shaped when present.
    peerDependenciesMeta: peerMeta as RuntimePackageJson["peerDependenciesMeta"],
    version: typeof record.version === "string" ? record.version : undefined,
  }
}

function normalizePeerRange(range: string): string | null {
  if (validRange(range)) return range
  if (range === "workspace:" || range === "workspace:*") return "*"
  const workspaceRange = range.startsWith("workspace:") ? range.slice("workspace:".length) : undefined
  if (workspaceRange && validRange(workspaceRange)) return workspaceRange
  return null
}

async function copyRuntimePackagesToNodeModules(options: { outputNodeModules: string, packages: RuntimePackage[], rootDir: string }): Promise<void> {
  const copied = new Set<string>()
  const staged = new Set<string>()
  const stagedTargets = new Set<string>()
  const ownedTargets = new Set<string>()
  const rootPackagePaths = new Map<string, { hoistedPeer: boolean, path: string, peerRanges: (string | null)[], version?: string }>()
  const resolver = createRequire(join(options.rootDir, "package.json"))
  const packages = options.packages.toSorted((a, b) => Number(Boolean(b.packageJsonPath)) - Number(Boolean(a.packageJsonPath)))
  for (const runtimePackage of packages) {
    if (!runtimePackage.packageJsonPath) continue
    const packageJsonPath = await realpath(runtimePackage.packageJsonPath)
    const packageJson = parseRuntimePackageJson(await readFile(packageJsonPath, "utf8"))
    rootPackagePaths.set(runtimePackage.name, {
      hoistedPeer: false,
      path: packageJsonPath,
      peerRanges: [],
      version: packageJson.version,
    })
  }
  for (const runtimePackage of packages) {
    const targetDir = join(options.outputNodeModules, ...runtimePackage.name.split("/"))
    let selectedPackage = runtimePackage
    if (!runtimePackage.packageJsonPath && stagedTargets.has(targetDir)) {
      const stagedPackageJsonPath = await resolvePackageJson(
        runtimePackage.name,
        createRequire(join(options.outputNodeModules, "package.json")),
        options.outputNodeModules,
      )
      if (stagedPackageJsonPath) selectedPackage = { ...runtimePackage, packageJsonPath: stagedPackageJsonPath }
    }
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, options.outputNodeModules, options.outputNodeModules, copied, staged, stagedTargets, ownedTargets, rootPackagePaths, selectedPackage)
  }
}

async function copyPackageToNodeModules(name: string, resolver: NodeJS.Require, fromDir: string, outputNodeModules: string, rootOutputNodeModules: string, copied: Set<string>, staged: Set<string>, stagedTargets: Set<string>, ownedTargets: Set<string>, rootPackagePaths: Map<string, { hoistedPeer: boolean, path: string, peerRanges: (string | null)[], version?: string }>, options: RuntimePackage): Promise<void> {
  let packageJsonPath = options.packageJsonPath
  if (packageJsonPath) {
    try {
      await access(packageJsonPath)
    } catch (error) {
      // SAFETY: Node filesystem failures expose their stable code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      packageJsonPath = undefined
    }
  }
  packageJsonPath ??= await resolvePackageJson(name, resolver, fromDir)
  packageJsonPath ??= await resolvePackageJson(name, createRequire(join(outputNodeModules, "package.json")), outputNodeModules)
  if (!packageJsonPath) {
    if (options.optional) return
    throw internalErrorDiagnostics.INTERNAL_B0021({ message: "Could not resolve package.json for " + name + "." })
  }
  let resolvedPackageJsonPath = await realpath(packageJsonPath)
  let packageJson = parseRuntimePackageJson(await readFile(resolvedPackageJsonPath, "utf8"))
  if (outputNodeModules === rootOutputNodeModules) {
    const existingPath = rootPackagePaths.get(name)
    const peerRanges = [...(existingPath?.peerRanges || []), ...(options.peerRange ? [normalizePeerRange(options.peerRange)] : [])]
    const satisfiesPeerRanges = (version: string): boolean => peerRanges.every(range => range !== null && satisfies(version, range))
    if (existingPath && existingPath.path !== resolvedPackageJsonPath && (existingPath.hoistedPeer || options.hoistedPeer)) {
      if (existingPath.version && satisfiesPeerRanges(existingPath.version)) {
        resolvedPackageJsonPath = existingPath.path
        packageJson = parseRuntimePackageJson(await readFile(resolvedPackageJsonPath, "utf8"))
      } else if (!existingPath.hoistedPeer || !packageJson.version || !satisfiesPeerRanges(packageJson.version)) {
        throw internalErrorDiagnostics.INTERNAL_B0022({ message: `Conflicting runtime package installations for ${name}: ${existingPath.path} and ${resolvedPackageJsonPath}.` })
      }
    }
    rootPackagePaths.set(name, {
      hoistedPeer: Boolean(existingPath?.hoistedPeer || options.hoistedPeer),
      path: resolvedPackageJsonPath,
      peerRanges,
      version: packageJson.version,
    })
  }
  const packageDir = dirname(resolvedPackageJsonPath)
  const packageKey = name + "\0" + resolvedPackageJsonPath
  if (copied.has(packageKey)) return
  const targetDir = join(outputNodeModules, ...name.split("/"))
  if (!options.ownsTarget && ownedTargets.has(targetDir)) return
  if (options.ownsTarget) ownedTargets.add(targetDir)
  const stagedKey = packageKey + "\0" + targetDir
  if (staged.has(stagedKey)) return
  copied.add(packageKey)
  if (resolve(packageDir) !== resolve(targetDir)) {
    await rm(targetDir, { force: true, recursive: true })
    await cp(packageDir, targetDir, {
      dereference: true,
      filter: source => !relative(packageDir, source).split(sep).includes("node_modules"),
      recursive: true,
    })
  }
  staged.add(stagedKey)
  stagedTargets.add(targetDir)
  const packageRequire = createRequire(resolvedPackageJsonPath)
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies || {}))
  const dependencyNames = new Set(
    Object.keys(packageJson.dependencies || {}).filter(dependencyName => !optionalDependencyNames.has(dependencyName)),
  )
  if (options.includeOptionalDependencies) {
    for (const dependencyName of Object.keys(packageJson.optionalDependencies || {})) {
      const dependencyPackageJsonPath = await resolvePackageJson(dependencyName, packageRequire, packageDir)
      if (!dependencyPackageJsonPath) continue
      const dependencyPackageJson = parseRuntimePackageJson(await readFile(dependencyPackageJsonPath, "utf8"))
      if (supportsDenoRuntime(dependencyPackageJson)) dependencyNames.add(dependencyName)
    }
  }
  for (const dependencyName of dependencyNames) {
    const hoistOptionalDependency = Boolean(packageJson.optionalDependencies?.[dependencyName])
      && (options.hoistOptionalDependencies || outputNodeModules === rootOutputNodeModules)
    const dependencyNodeModules = hoistOptionalDependency
      ? outputNodeModules
      : join(targetDir, "node_modules")
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, dependencyNodeModules, rootOutputNodeModules, copied, staged, stagedTargets, ownedTargets, rootPackagePaths, {
      hoistOptionalDependencies: hoistOptionalDependency,
      includeOptionalDependencies: options.includeOptionalDependencies,
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
      ownsTarget: hoistOptionalDependency,
      optional: Boolean(packageJson.optionalDependencies?.[dependencyName]),
    })
  }
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (packageJson.peerDependenciesMeta?.[dependencyName]?.optional) continue
      await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, rootOutputNodeModules, rootOutputNodeModules, copied, staged, stagedTargets, ownedTargets, rootPackagePaths, {
        hoistedPeer: true,
        includeOptionalDependencies: options.includeOptionalDependencies,
        includePeerDependencies: true,
        name: dependencyName,
        optional: false,
        peerRange: packageJson.peerDependencies![dependencyName],
      })
    }
  }
  copied.delete(packageKey)
}

function supportsDenoRuntime(packageJson: RuntimePackageJson): boolean {
  // napi-rs binaries such as `@libsql/linux-x64-musl` omit `libc` and name the C library instead.
  const libc = packageJson.libc ?? (/-(?:linux)?musl/.test(packageJson.name ?? "") ? ["musl"] : undefined)
  return denoRuntimeTargets.some(target =>
    supportsConstraint(packageJson.os, target.os)
    && supportsConstraint(packageJson.cpu, target.cpu)
    && supportsConstraint(libc, target.libc),
  )
}

function supportsConstraint(values: string[] | undefined, target: string): boolean {
  if (!values?.length) return true
  if (values.length === 1 && values[0] === "any") return true
  if (values.includes(`!${target}`)) return false
  const included = values.filter(value => !value.startsWith("!"))
  return included.length === 0 || included.includes(target)
}

export function assertSupportedRelocatedImports(source: string, outputName: string, allowedLocalImports: string[] = []): void {
  const { createRequireAliases, executableSource } = analyzeImportSource(source)
  for (const match of executableSource.matchAll(/new URL\(\s*(["'`])(\.[^"'`]*)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const specifier = cookImportSpecifier(match[2]!)
    if (allowedLocalImports.includes(specifier)) continue
    throw internalErrorDiagnostics.INTERNAL_B0025({ message: `Deno ${outputName} contains an unsupported computed local import ${JSON.stringify(specifier)}. Use a static import so ViteHub can bundle its dependency.` })
  }
  let remaining = executableSource
    .replaceAll(/import\s*\(\s*new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)\.href\s*\)/g, (expression, _quote: string, rawSpecifier: string) => allowedLocalImports.includes(cookImportSpecifier(rawSpecifier)) ? "" : expression)
  for (const literalImport of findLiteralDynamicImports(remaining).reverse()) {
    remaining = remaining.slice(0, literalImport.start) + " ".repeat(literalImport.literalEnd - literalImport.start) + remaining.slice(literalImport.literalEnd)
  }
  for (const match of remaining.matchAll(/\bimport\s*\(/g)) {
    if (isStandaloneCall(remaining, match.index!)) {
      throw internalErrorDiagnostics.INTERNAL_B0026({ message: `Deno ${outputName} contains an unsupported computed import. Use a static import so ViteHub can bundle its dependency.` })
    }
  }
  const requireNames = ["__require", "require", ...createRequireAliases].map(escapeRegExp).join("|")
  const computedRequire = new RegExp(String.raw`\b(?:` + requireNames + String.raw`)(?:\s*\.\s*resolve)?\s*(?:\?\.)?\s*\(\s*(?=[^)\s])(?!["'\x60])`, "g")
  for (const match of remaining.matchAll(computedRequire)) {
    if (isStandaloneCall(remaining, match.index!)) {
      throw internalErrorDiagnostics.INTERNAL_B0027({ message: `Deno ${outputName} contains an unsupported computed require. Use a static import so ViteHub can bundle its dependency.` })
    }
  }
}

function isUnconditionalTopLevelExpression(source: string, expressionStart: number, expressionEnd: number): boolean {
  let braceDepth = 0
  for (let index = 0; index < expressionStart; index++) {
    if (source[index] === "{") braceDepth++
    else if (source[index] === "}") braceDepth--
  }
  if (braceDepth !== 0) return false
  const statementPrefix = source.slice(0, expressionStart).split(/[;\n]/).at(-1)!
  const precedingLine = source.slice(0, expressionStart).split("\n").at(-2)?.trim() ?? ""
  return !/(?:^|\s)(?:else\s+)?(?:if|for|while|with)\s*\(/.test(statementPrefix)
    && !isGuardedConciseArrow(source, expressionStart, expressionEnd)
    && !/^(?:else\s+)?(?:if|for|while|with)\s*\(/.test(precedingLine)
    && !/&&|\|\||\?\?|\?\./.test(statementPrefix)
    && !/(^|[^?])\?(?![?.])/.test(statementPrefix)
}

function hasTopLevelRelocatableDynamicImport(source: string, specifier: string): boolean {
  const { executableSource } = analyzeImportSource(source)
  if (findLiteralDynamicImports(executableSource)
    .some(entry => entry.specifier === specifier && isUnconditionalTopLevelExpression(executableSource, entry.start, entry.literalEnd))) return true
  return [...executableSource.matchAll(/(?:^|[^\w$.#])import\s*\(\s*new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)\.href\s*\)/g)]
    .some(match => cookImportSpecifier(match[2]!) === specifier && isUnconditionalTopLevelExpression(executableSource, match.index! + match[0].indexOf("import"), match.index! + match[0].length))
}

function hasRelocatableStaticImport(source: string, specifier: string): boolean {
  const { executableSource } = analyzeImportSource(source)
  const patterns = [
    /(?:^|;)\s*import\s*["']([^"']+)["']/gm,
    /(?:^|;)\s*import[^;\n]*?\bfrom\s*["']([^"']+)["']/gm,
  ]
  return patterns.some(pattern => [...executableSource.matchAll(pattern)]
    .some(match => cookImportSpecifier(match[1]!) === specifier))
}

function denoDeployRunnerSource(deploymentName: string | undefined, entrypoint: string): string {
  return `import { spawn } from "node:child_process"
import { access, cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const organization = process.env.DENO_DEPLOY_ORG
const app = process.env.DENO_DEPLOY_APP || ${JSON.stringify(deploymentName)}
const region = process.env.DENO_DEPLOY_REGION || "global"
const entrypoint = ${JSON.stringify(entrypoint)}

if (!organization || !app) {
  throw new Error("DENO_DEPLOY_ORG and DENO_DEPLOY_APP are required.")
}

let activeChild

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("deno", args, { cwd, stdio: "inherit" })
    activeChild = child
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      activeChild = undefined
      resolve({ code, signal })
    })
  })
}

async function enclosingGitRoot(path) {
  let current = resolve(path)
  while (true) {
    try {
      await access(join(current, ".git"))
      return current
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const sourceRoot = await realpath(fileURLToPath(new URL(".", import.meta.url)))
const uploadRoot = await realpath(await mkdtemp(join(tmpdir(), "vitehub-deno-deploy-")))
const signals = ["SIGINT", "SIGTERM"]
let interrupted = false
const handleSignal = (signal) => {
  interrupted = true
  activeChild?.kill(signal)
  void rm(uploadRoot, { force: true, recursive: true }).finally(() => {
    process.kill(process.pid, signal)
  })
}
for (const signal of signals) process.once(signal, handleSignal)

try {
  if (contains(sourceRoot, uploadRoot) || await enclosingGitRoot(uploadRoot)) {
    throw new Error("Deno deployment staging must be outside the generated output and any enclosing Git repository. Set TMPDIR to an external directory.")
  }
  await cp(sourceRoot, uploadRoot, { recursive: true })

  if (!interrupted) {
    const common = ["--allow-node-modules", "--org", organization, "--app", app]
    const creation = await run(["deploy", "create", ".", "--source", "local", "--do-not-use-detected-build-config", "--runtime-mode", "dynamic", "--entrypoint", entrypoint, "--working-directory", ".", "--region", region, ...common], uploadRoot)
    if (creation.signal != null && !interrupted) {
      throw new Error("deno deploy create exited with " + creation.signal)
    }
    if (!interrupted && creation.code !== 0) {
      const deployment = await run(["deploy", ".", "--prod", "--config", "deno.json", ...common], uploadRoot)
      if (deployment.code !== 0) {
        throw new Error("deno deploy exited with " + (deployment.signal || "code " + deployment.code))
      }
    }
  }
} finally {
  try {
    await rm(uploadRoot, { force: true, recursive: true })
  } finally {
    for (const signal of signals) process.off(signal, handleSignal)
  }
}
`
}

export async function finalizeDenoDeploymentOutput(
  options: FinalizeDenoDeploymentOutputOptions,
): Promise<void> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? ".output")
  const releaseLock = await acquireDenoDeploymentLock(outputDir)
  try {
    await recoverInterruptedDenoDeploymentOutput(outputDir)
    const stageRoot = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.vitehub-`))
    activeDenoDeploymentStages.add(stageRoot)
    const stagedOutputDir = join(stageRoot, "output")
    const previousOutputDir = join(stageRoot, "previous")
    try {
      await cp(outputDir, stagedOutputDir, { recursive: true })
      await finalizeStagedDenoDeploymentOutput({ ...options, outputDir: stagedOutputDir })
      await rename(outputDir, previousOutputDir)
      try {
        await rename(stagedOutputDir, outputDir)
      }
      catch (error) {
        await rename(previousOutputDir, outputDir)
        throw error
      }
    }
    finally {
      activeDenoDeploymentStages.delete(stageRoot)
      await rm(stageRoot, { force: true, recursive: true })
    }
  }
  finally {
    await releaseLock()
  }
}

export async function acquireDenoDeploymentLock(outputDir: string): Promise<() => Promise<void>> {
  const lockPath = `${outputDir}.vitehub-lock`
  const ownerPath = join(lockPath, "owner")
  const publishLock = async () => {
    const candidatePath = `${lockPath}.candidate.${process.pid}.${randomUUID()}`
    try {
      await mkdir(candidatePath)
      await writeFile(join(candidatePath, "owner"), `${process.pid}\n`, "utf8")
      await rename(candidatePath, lockPath)
    }
    finally {
      await rm(candidatePath, { force: true, recursive: true })
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await publishLock()
      return () => rm(lockPath, { force: true, recursive: true })
    }
    catch (error) {
      // SAFETY: Node filesystem errors expose their stable code through ErrnoException.
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      const inspectedOwner = await readFile(ownerPath, "utf8").catch(() => "")
      const owner = Number.parseInt(inspectedOwner, 10)
      let ownerAlive = Number.isSafeInteger(owner) && owner > 0
      if (ownerAlive) {
        try { process.kill(owner, 0) }
        catch (signalError) {
          // SAFETY: Node process errors expose their stable code through ErrnoException.
          if ((signalError as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false
          else throw signalError
        }
      }
      if (ownerAlive) throw internalErrorDiagnostics.INTERNAL_B0028({ message: `Deno deployment output ${JSON.stringify(outputDir)} is already being finalized by process ${owner}.` })

      const claimedLockPath = `${lockPath}.orphan.${process.pid}.${randomUUID()}`
      try {
        await rename(lockPath, claimedLockPath)
      }
      catch (claimError) {
        // SAFETY: Node filesystem errors expose their stable code through ErrnoException.
        if ((claimError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw claimError
      }
      const claimedOwner = await readFile(join(claimedLockPath, "owner"), "utf8").catch(() => "")
      if (claimedOwner !== inspectedOwner) {
        await rename(claimedLockPath, lockPath).catch(async (restoreError) => {
          // SAFETY: Node filesystem errors expose their stable code through ErrnoException.
          if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError
          await rm(claimedLockPath, { force: true, recursive: true })
        })
        continue
      }
      await rm(claimedLockPath, { force: true, recursive: true })
    }
  }
  throw internalErrorDiagnostics.INTERNAL_B0029({ message: `Could not acquire the Deno deployment output lock for ${JSON.stringify(outputDir)}.` })
}

async function recoverInterruptedDenoDeploymentOutput(outputDir: string): Promise<void> {
  let outputExists = true
  try {
    await access(outputDir)
  }
  catch (error) {
    // SAFETY: Node filesystem errors expose their stable code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    outputExists = false
  }

  const parentDir = dirname(outputDir)
  const stagePrefix = `.${basename(outputDir)}.vitehub-`
  const recoveries = (await Promise.all((await readdir(parentDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(stagePrefix))
    .map(async (entry) => {
      const stageRoot = join(parentDir, entry.name)
      if (activeDenoDeploymentStages.has(stageRoot)) return
      const previousOutputDir = join(stageRoot, "previous")
      const previous = await stat(previousOutputDir).catch((error) => {
        // SAFETY: Node filesystem errors expose their stable code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      })
      const stage = await stat(stageRoot)
      return { previousOutputDir: previous ? previousOutputDir : undefined, stageRoot, updatedAt: previous?.mtimeMs ?? stage.mtimeMs }
    })))
    .filter(recovery => recovery !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (outputExists) {
    await Promise.all(recoveries.map(recovery => rm(recovery.stageRoot, { force: true, recursive: true })))
    return
  }
  const recovery = recoveries.find(entry => entry.previousOutputDir)
  if (!recovery?.previousOutputDir) return
  await rename(recovery.previousOutputDir, outputDir)
  await Promise.all(recoveries.map(entry => rm(entry.stageRoot, { force: true, recursive: true })))
}

async function finalizeStagedDenoDeploymentOutput(
  options: FinalizeDenoDeploymentOutputOptions,
): Promise<void> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? ".output")
  const serverDir = join(outputDir, "server")
  const scheduleSource = join(options.rootDir, ".vitehub", "schedule", "deno-cron.mjs")
  const applicationEntrySource = join(options.rootDir, "main.ts")
  const resolvedPackageJsonPaths = new Map<string, string>()
  const runtimePackages = new Map<string, RuntimePackage>()
  await addServerRuntimePackages(options.serverPackages, options.rootDir, resolvedPackageJsonPaths, runtimePackages)
  let entrypoint = "server/index.mjs"
  let hasSchedule = false
  try {
    await access(scheduleSource)
    if (options.hasScheduleIntegration === false) {
      await rm(scheduleSource, { force: true })
      throw Object.assign(internalErrorDiagnostics.INTERNAL_B0030({ message: "stale Deno Schedule output" }), { code: "ENOENT" })
    }
    hasSchedule = true
    await access(applicationEntrySource)
    await mkdir(join(outputDir, "schedule"), { recursive: true })
    const scheduleOutput = join(outputDir, "schedule", "deno-cron.mjs")
    const temporaryScheduleOutput = `${scheduleOutput}.vitehub-tmp`
    await bundleEsmEntry(scheduleSource, temporaryScheduleOutput, {
      external: [...builtinModuleNames],
      alias: options.alias,
      conditions: options.conditions,
      define: options.define,
      extensions: options.extensions,
      format: "esm",
      packages: "external",
      platform: "neutral",
      preserveSymlinks: options.preserveSymlinks,
      mainFields: options.mainFields,
      plugins: [packageImportPlugin(), runtimePackageResolutionPlugin(options.rootDir, options.alias, resolvedPackageJsonPaths, runtimePackages)],
      rootDir: options.rootDir,
      workingDir: options.rootDir,
    })
    await publishProviderSourcesToDeploymentOutputs({
      destinations: [{
        files: [temporaryScheduleOutput],
        runtimeSourcesDir: "./.vitehub/schedule/sources",
        sourcesDir: join(outputDir, ".vitehub/schedule/sources"),
      }],
      publishedSourcesDir: join(options.rootDir, ".vitehub/schedule/sources"),
    })
    assertSupportedRelocatedImports(await readFile(temporaryScheduleOutput, "utf8"), "Schedule bundle")
    const applicationOutput = join(outputDir, "main.ts")
    const temporaryApplicationOutput = `${applicationOutput}.vitehub-tmp`
    try {
      await bundleEsmEntry(applicationEntrySource, temporaryApplicationOutput, {
        external: [...builtinModuleNames, "./schedule/deno-cron.mjs", "./server/index.mjs"],
        alias: options.alias,
        banner: "// @ts-nocheck -- generated JavaScript is emitted with a .ts entrypoint for Deno Deploy",
        conditions: options.conditions,
        define: options.define,
        extensions: options.extensions,
        format: "esm",
        packages: "external",
        platform: "neutral",
        preserveSymlinks: options.preserveSymlinks,
        mainFields: options.mainFields,
        plugins: [packageImportPlugin(), runtimePackageResolutionPlugin(options.rootDir, options.alias, resolvedPackageJsonPaths, runtimePackages)],
        rootDir: options.rootDir,
        workingDir: options.rootDir,
      })
      const applicationBundle = await readFile(temporaryApplicationOutput, "utf8")
      assertSupportedRelocatedImports(
        applicationBundle,
        "application entrypoint",
        ["./schedule/deno-cron.mjs", "./server/index.mjs"],
      )
      if (!hasTopLevelRelocatableDynamicImport(applicationBundle, "./schedule/deno-cron.mjs")
        && !hasRelocatableStaticImport(applicationBundle, "./schedule/deno-cron.mjs")) {
        throw internalErrorDiagnostics.INTERNAL_B0031({ message: 'Deno Schedule output requires the project-root "main.ts" application entrypoint to import "./schedule/deno-cron.mjs".' })
      }
      if (!hasTopLevelRelocatableDynamicImport(applicationBundle, "./server/index.mjs")
        && !hasRelocatableStaticImport(applicationBundle, "./server/index.mjs")) {
        throw internalErrorDiagnostics.INTERNAL_B0032({ message: 'Deno Schedule output requires the project-root "main.ts" application entrypoint to import "./server/index.mjs".' })
      }
      await rename(temporaryApplicationOutput, applicationOutput)
      await rename(temporaryScheduleOutput, scheduleOutput)
    }
    finally {
      await rm(temporaryApplicationOutput, { force: true })
      await rm(temporaryScheduleOutput, { force: true })
    }
    entrypoint = "main.ts"
  }
  catch (error) {
    // SAFETY: filesystem access and cleanup failures expose Node's optional error code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (hasSchedule) {
      throw internalErrorDiagnostics.INTERNAL_B0033({ message: 'Deno Schedule output requires a project-root "main.ts" application entrypoint.', cause: error })
    }
  }
  const nodeTypesPackageJson = await resolvePackageJson(
    "@types/node",
    createRequire(join(options.rootDir, "package.json")),
    options.rootDir,
  ) ?? await resolvePackageJson("@types/node", createRequire(import.meta.url), dirname(fileURLToPath(import.meta.url)))
  const hasNodeTypes = nodeTypesPackageJson !== undefined
  if (nodeTypesPackageJson && !runtimePackages.has("@types/node")) {
    addRuntimePackage(runtimePackages, { name: "@types/node", optional: false, packageJsonPath: await realpath(nodeTypesPackageJson) })
  }
  await copyRuntimePackagesToNodeModules({
    outputNodeModules: join(outputDir, "node_modules"),
    packages: [...runtimePackages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rootDir: options.rootDir,
  })

  const denoConfig: {
    compilerOptions: { types: string[] }
    deploy: { runtime: { cwd: string, entrypoint: string, mode: string } }
    nodeModulesDir: string
    tasks: { start: string }
  } = {
    compilerOptions: { types: [] },
    deploy: {
      runtime: {
        mode: "dynamic",
        entrypoint: `./${entrypoint}`,
        cwd: ".",
      },
    },
    nodeModulesDir: "manual",
    tasks: { start: `deno run ${hasSchedule ? "--unstable-cron " : ""}-A ./${entrypoint}` },
  }
  if (hasNodeTypes) denoConfig.compilerOptions = { types: ["./node_modules/@types/node/index.d.ts"] }
  // Existing apps may retain this entrypoint; keep its import opaque to Deno's type checker.
  await writeFile(
    join(serverDir, "index.ts"),
    'await import("./index." + "mjs")\n',
    "utf8",
  )
  await writeFile(join(outputDir, "deno.json"), `${JSON.stringify(denoConfig, null, 2)}\n`, "utf8")
  await writeFile(join(outputDir, "deploy.mjs"), denoDeployRunnerSource(options.deploymentName, entrypoint), "utf8")
}
