import { access, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

import type { Plugin } from "esbuild"

import { bundleEsmEntry, type ViteAlias } from "./esbuild.ts"

const builtinModuleNames = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const runtimeExtensions = new Set([".cjs", ".js", ".mjs", ".ts"])
const denoRuntimeTargets = [
  { cpu: "arm64", libc: "glibc", os: "linux" },
  { cpu: "x64", libc: "glibc", os: "linux" },
] as const

interface FinalizeDenoDeploymentOutputOptions {
  alias?: ViteAlias[]
  conditions?: string[]
  deploymentName?: string
  hasScheduleIntegration?: boolean
  outputDir?: string
  rootDir: string
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  )
    return
  if (builtinModuleNames.has(specifier) || specifier.includes(":")) return
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

function collectBundledPackageNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/\s]+)/g,
  )) {
    const name = packageNameFromSpecifier(match[1]!)
    if (name) names.add(name)
  }
  return names
}

function collectBundledPackages(source: string): Map<string, string> {
  const packages = new Map<string, string>()
  for (const match of source.matchAll(
    /(?:^|[\s"'`(])((?:[A-Za-z]:)?[^\s"'`()]*?node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?((?:@[^/\\]+[/\\])?[^/\\\s"'`()]+))/gm,
  )) {
    const name = packageNameFromSpecifier(match[2]!.replaceAll("\\", "/"))
    if (name) packages.set(name, match[1]!)
  }
  return packages
}

function collectImportedPackageNames(source: string): Set<string> {
  const names = new Set<string>()
  const executableSource = maskInertImportText(source)
  const patterns = [
    /(?:^|;)\s*(?:import|export)\s*["']([^"']+)["']/gm,
    /(?:^|;)\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^"']+)["']/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of executableSource.matchAll(pattern)) {
      const name = packageNameFromSpecifier(match[1]!)
      if (name) names.add(name)
    }
  }
  for (const { specifier } of findLiteralDynamicImports(executableSource)) {
    const name = packageNameFromSpecifier(specifier)
    if (name) names.add(name)
  }
  return names
}

interface LiteralDynamicImport {
  end: number
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
    if (escape === undefined) throw new Error("Deno output contains an incomplete import escape sequence.")
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
        throw new Error("Deno output contains an unsupported legacy octal import escape sequence.")
      }
      cooked += simpleEscape
      continue
    }
    if (escape === "x") {
      const digits = source.slice(index + 1, index + 3)
      if (!/^[\dA-Fa-f]{2}$/.test(digits)) throw new Error("Deno output contains an invalid hexadecimal import escape sequence.")
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
          throw new Error("Deno output contains an invalid Unicode import escape sequence.")
        }
        cooked += String.fromCodePoint(codePoint)
        index = end
        continue
      }
      const digits = source.slice(index + 1, index + 5)
      if (!/^[\dA-Fa-f]{4}$/.test(digits)) throw new Error("Deno output contains an invalid Unicode import escape sequence.")
      cooked += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    if (/[1-9]/.test(escape)) throw new Error("Deno output contains an unsupported legacy octal import escape sequence.")
    cooked += escape
  }
  return cooked
}

function findLiteralDynamicImports(source: string): LiteralDynamicImport[] {
  const imports: LiteralDynamicImport[] = []
  for (const match of source.matchAll(/(?:^|[^\w$.#])import\s*\(\s*(["'`])/g)) {
    const start = match.index! + match[0].indexOf("import")
    const quote = match[1]!
    const literalStart = match.index! + match[0].length - 1
    let literalEnd = literalStart + 1
    while (literalEnd < source.length) {
      if (source[literalEnd] === "\\") literalEnd += 2
      else if (source[literalEnd++] === quote) break
    }
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
      end: cursor,
      specifier: cookImportSpecifier(source.slice(literalStart + 1, literalEnd - 1)),
      start,
    })
  }
  return imports
}

function maskInertImportText(source: string): string {
  let output = ""
  let index = 0

  function maskLiteralText(text: string): string {
    return text.replace(/[^\n]/g, " ")
  }

  function maskLiteralOperand(text: string): string {
    const masked = maskLiteralText(text)
    const lastLineCharacter = masked.search(/[^\n](?=\n*$)/)
    return lastLineCharacter === -1
      ? masked
      : masked.slice(0, lastLineCharacter) + "0" + masked.slice(lastLineCharacter + 1)
  }

  function scanTemplate(): void {
    if (/(?:^|[^\w$.#])import\s*\(\s*$/.test(output)) {
      let literalEnd = index + 1
      while (literalEnd < source.length) {
        if (source[literalEnd] === "\\") literalEnd += 2
        else if (source[literalEnd] === "$" && source[literalEnd + 1] === "{") break
        else {
          if (source[literalEnd++] === "`") {
            output += source.slice(index, literalEnd)
            index = literalEnd
            return
          }
        }
      }
    }
    output += " "
    index++
    while (index < source.length) {
      if (source[index] === "\\") {
        const end = Math.min(index + 2, source.length)
        output += maskLiteralText(source.slice(index, end))
        index = end
      }
      else if (source[index] === "`") {
        output += "0"
        index++
        return
      }
      else if (source[index] === "$" && source[index + 1] === "{") {
        output += "${"
        index += 2
        scanCode(true)
      }
      else {
        output += source[index] === "\n" ? "\n" : " "
        index++
      }
    }
  }

  function scanCode(stopAtTemplateExpressionEnd = false): void {
    let braceDepth = 0
    while (index < source.length) {
      const character = source[index]!
      const next = source[index + 1]
      if (stopAtTemplateExpressionEnd && character === "}" && braceDepth === 0) {
        output += character
        index++
        return
      }
      if (character === "/" && next === "/") {
        const end = source.indexOf("\n", index)
        const length = (end === -1 ? source.length : end) - index
        output += " ".repeat(length)
        index += length
        continue
      }
      if (character === "/" && next === "*") {
        const closing = source.indexOf("*/", index + 2)
        const length = (closing === -1 ? source.length : closing + 2) - index
        output += maskLiteralText(source.slice(index, index + length))
        index += length
        continue
      }
      if (character === "/" && canStartRegexLiteral(output)) {
        let end = index + 1
        let inCharacterClass = false
        while (end < source.length) {
          if (source[end] === "\\") end += 2
          else if (source[end] === "[") {
            inCharacterClass = true
            end++
          }
          else if (source[end] === "]") {
            inCharacterClass = false
            end++
          }
          else if (source[end] === "/" && !inCharacterClass) {
            end++
            while (/[A-Za-z]/.test(source[end] || "")) end++
            break
          }
          else if (source[end] === "\n" || source[end] === "\r") break
          else end++
        }
        output += maskLiteralOperand(source.slice(index, end))
        index = end
        continue
      }
      if (character === "`") {
        scanTemplate()
        continue
      }
      if (character === '"' || character === "'") {
        const prefix = output.slice(Math.max(0, output.length - 120))
        const keep = /(?:\b(?:from|import|export)|\b(?:import|require)\s*\(|\bnew\s+URL\s*\()\s*$/.test(prefix)
        let end = index + 1
        while (end < source.length) {
          if (source[end] === "\\") end += 2
          else if (source[end++] === character) break
        }
        const literal = source.slice(index, end)
        output += keep ? literal : maskLiteralOperand(literal)
        index = end
        continue
      }
      if (character === "{") braceDepth++
      else if (character === "}") braceDepth--
      output += character
      index++
    }
  }

  scanCode()
  return output
}

function canStartRegexLiteral(output: string): boolean {
  const prefix = output.trimEnd()
  if (!prefix) return true
  if (prefix.endsWith("++") || prefix.endsWith("--")) return false
  if ("([{,:;=!?&|~%^<>*+-".includes(prefix.at(-1)!)) return true
  if (endsWithDeclaration(prefix)) return true
  if (endsWithControlCondition(prefix)) return true
  if (endsWithStatementBlock(prefix)) return true
  return /\b(?:await|case|delete|do|else|in|instanceof|of|return|throw|typeof|void|yield)$/.test(prefix)
}

function matchingOpeningDelimiter(source: string, opening: string, closing: string): number | undefined {
  if (!source.endsWith(closing)) return
  const openings: number[] = []
  let quote: "\"" | "'" | "`" | undefined
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (quote) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === opening) openings.push(index)
    else if (character === closing) {
      const match = openings.pop()
      if (index === source.length - 1) return match
    }
  }
}

function endsWithControlCondition(source: string): boolean {
  const conditionStart = matchingOpeningDelimiter(source, "(", ")")
  if (conditionStart === undefined) return false
  return /\b(?:catch|if|for|switch|while|with)$/.test(source.slice(0, conditionStart).trimEnd())
}

function endsWithStatementBlock(source: string): boolean {
  const bodyStart = matchingOpeningDelimiter(source, "{", "}")
  if (bodyStart === undefined) return false
  const header = source.slice(0, bodyStart).trimEnd()
  return /(?:^|[;{}\n])\s*[\w$]+\s*:$/.test(header)
    || /\b(?:catch|do|else|finally|try)$/.test(header)
    || endsWithControlCondition(header)
    || /(?:^|[;{}\n])\s*$/.test(header)
}

function endsWithDeclaration(source: string): boolean {
  const bodyStart = matchingOpeningDelimiter(source, "{", "}")
  if (bodyStart === undefined) return false
  const header = source.slice(0, bodyStart).trimEnd()
  return /(?:^|[;{}])\s*(?:(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function(?:\s*\*)?\s+[\w$]+\s*\([^;]*\)|class\s+[\w$]+(?:\s+extends\s+[^;{}]+)?)|export\s+default\s+(?:(?:async\s+)?function(?:\s*\*)?(?:\s+[\w$]+)?\s*\([^;]*\)|class(?:\s+[\w$]+)?(?:\s+extends\s+[^;{}]+)?))\s*$/.test(header)
}

function packageImportPlugin(): Plugin {
  const resolvingPackageImport = "vitehubResolvingPackageImport"
  return {
    name: "vitehub-package-imports",
    setup(build) {
      build.onResolve({ filter: /^#/ }, async (args) => {
        if (args.pluginData?.[resolvingPackageImport]) return
        return build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: { ...args.pluginData, [resolvingPackageImport]: true },
          resolveDir: args.resolveDir,
          with: args.with,
        })
      })
    },
  }
}

export function collectDenoRuntimePackageNames(source: string): string[] {
  return [...new Set([
    ...collectBundledPackageNames(source),
    ...collectImportedPackageNames(source),
  ])].sort()
}

interface RuntimePackage {
  hoistOptionalDependencies?: boolean
  includeOptionalDependencies?: boolean
  includePeerDependencies?: boolean
  name: string
  onlyIfOptionalDependencies?: boolean
  optional?: boolean
  packageJsonPath?: string
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
}

function parseRuntimePackageJson(source: string): RuntimePackageJson {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected package.json to contain an object.")
  const record = value as Record<string, unknown>
  const stringArray = (key: string): string[] | undefined => {
    const property = record[key]
    if (property === undefined) return
    if (!Array.isArray(property) || !property.every(item => typeof item === "string")) throw new Error(`Expected package.json ${key} to contain strings.`)
    return property
  }
  const stringRecord = (key: string): Record<string, string> | undefined => {
    const property = record[key]
    if (property === undefined) return
    if (!property || typeof property !== "object" || Array.isArray(property) || !Object.values(property).every(item => typeof item === "string")) throw new Error(`Expected package.json ${key} to contain string values.`)
    return property as Record<string, string>
  }
  const peerMeta = record.peerDependenciesMeta
  if (peerMeta !== undefined && (!peerMeta || typeof peerMeta !== "object" || Array.isArray(peerMeta))) throw new Error("Expected package.json peerDependenciesMeta to contain an object.")
  if (record.name !== undefined && typeof record.name !== "string") throw new Error("Expected package.json name to contain a string.")
  return {
    cpu: stringArray("cpu"),
    dependencies: stringRecord("dependencies"),
    libc: stringArray("libc"),
    name: record.name,
    optionalDependencies: stringRecord("optionalDependencies"),
    os: stringArray("os"),
    peerDependencies: stringRecord("peerDependencies"),
    peerDependenciesMeta: peerMeta as RuntimePackageJson["peerDependenciesMeta"],
  }
}

async function copyRuntimePackagesToNodeModules(options: { outputNodeModules: string, packages: RuntimePackage[], rootDir: string }): Promise<void> {
  const copied = new Set<string>()
  const staged = new Set<string>()
  const resolver = createRequire(join(options.rootDir, "package.json"))
  for (const runtimePackage of options.packages) {
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, options.outputNodeModules, copied, staged, runtimePackage)
  }
}

async function copyPackageToNodeModules(name: string, resolver: NodeJS.Require, fromDir: string, outputNodeModules: string, copied: Set<string>, staged: Set<string>, options: RuntimePackage): Promise<void> {
  let packageJsonPath = options.packageJsonPath
  if (packageJsonPath) {
    try {
      await access(packageJsonPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      packageJsonPath = undefined
    }
  }
  packageJsonPath ??= await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error("Could not resolve package.json for " + name + ".")
  }
  const resolvedPackageJsonPath = await realpath(packageJsonPath)
  const packageDir = dirname(resolvedPackageJsonPath)
  const packageJson = parseRuntimePackageJson(await readFile(resolvedPackageJsonPath, "utf8"))
  if (options.onlyIfOptionalDependencies && !Object.keys(packageJson.optionalDependencies || {}).length) return
  const packageKey = name + "\0" + resolvedPackageJsonPath
  if (copied.has(packageKey)) return
  const targetDir = join(outputNodeModules, ...name.split("/"))
  const stagedKey = packageKey + "\0" + targetDir
  if (staged.has(stagedKey)) return
  copied.add(packageKey)
  await rm(targetDir, { force: true, recursive: true })
  await cp(packageDir, targetDir, {
    dereference: true,
    filter: source => relative(packageDir, source).split(sep)[0] !== "node_modules",
    recursive: true,
  })
  staged.add(stagedKey)
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
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) dependencyNames.add(dependencyName)
    }
  }
  for (const dependencyName of dependencyNames) {
    const dependencyNodeModules = options.hoistOptionalDependencies && packageJson.optionalDependencies?.[dependencyName]
      ? outputNodeModules
      : join(targetDir, "node_modules")
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, dependencyNodeModules, copied, staged, {
      hoistOptionalDependencies: options.hoistOptionalDependencies && Boolean(packageJson.optionalDependencies?.[dependencyName]),
      includeOptionalDependencies: options.includeOptionalDependencies,
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
      optional: Boolean(packageJson.optionalDependencies?.[dependencyName]),
    })
  }
  copied.delete(packageKey)
}

function supportsDenoRuntime(packageJson: RuntimePackageJson): boolean {
  return denoRuntimeTargets.some(target =>
    supportsConstraint(packageJson.os, target.os)
    && supportsConstraint(packageJson.cpu, target.cpu)
    && supportsConstraint(packageJson.libc, target.libc),
  )
}

function supportsConstraint(values: string[] | undefined, target: string): boolean {
  if (!values?.length) return true
  if (values.length === 1 && values[0] === "any") return true
  if (values.includes(`!${target}`)) return false
  const included = values.filter(value => !value.startsWith("!"))
  return included.length === 0 || included.includes(target)
}

async function resolvePackageJson(name: string, resolver: NodeJS.Require, fromDir: string): Promise<string | undefined> {
  try {
    return resolver.resolve(name + "/package.json")
  } catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }
  try {
    let current = dirname(resolver.resolve(name))
    while (current !== dirname(current)) {
      const candidate = join(current, "package.json")
      try {
        await access(candidate)
        const packageJson = parseRuntimePackageJson(await readFile(candidate, "utf8"))
        if (packageJson.name === name) return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      current = dirname(current)
    }
  } catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }
  let current = fromDir
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"), "package.json")
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function isPackageResolutionMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

async function runtimeSourceFiles(serverDir: string): Promise<string[]> {
  if ((await stat(serverDir)).isFile()) return [serverDir]
  const entries = await readdir(serverDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && runtimeExtensions.has(extname(entry.name)))
    .map((entry) => resolve(entry.parentPath, entry.name))
}

async function readRuntimePackages(runtimeDirs: string[], rootDir: string): Promise<RuntimePackage[]> {
  const packages = new Map<string, RuntimePackage>()
  for (const file of (await Promise.all(runtimeDirs.map(runtimeSourceFiles))).flat()) {
    const source = await readFile(file, "utf8")
    for (const [name, packagePath] of collectBundledPackages(source)) {
      const existing = packages.get(name)
      packages.set(name, {
        ...existing,
        hoistOptionalDependencies: true,
        includeOptionalDependencies: true,
        includePeerDependencies: true,
        name,
        onlyIfOptionalDependencies: existing?.onlyIfOptionalDependencies ?? true,
        optional: existing?.optional ?? true,
        packageJsonPath: resolve(isAbsolute(packagePath) ? packagePath : resolve(rootDir, packagePath), "package.json"),
      })
    }
    for (const name of collectImportedPackageNames(source)) {
      packages.set(name, {
        ...packages.get(name),
        includeOptionalDependencies: true,
        includePeerDependencies: true,
        name,
        onlyIfOptionalDependencies: false,
        optional: false,
      })
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function assertSupportedRelocatedImports(source: string, outputName: string, allowedLocalImports: string[] = []): void {
  const executableSource = maskInertImportText(source)
  for (const match of executableSource.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import\.meta\.url\s*\)/g)) {
    const specifier = match[1]!
    if (allowedLocalImports.includes(specifier)) continue
    throw new Error(`Deno ${outputName} contains an unsupported computed local import ${JSON.stringify(specifier)}. Use a static import so ViteHub can bundle its dependency.`)
  }
  let remaining = executableSource
    .replaceAll(/import\s*\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)\.href\s*\)/g, (expression, specifier: string) => allowedLocalImports.includes(specifier) ? "" : expression)
  for (const literalImport of findLiteralDynamicImports(remaining).reverse()) {
    remaining = remaining.slice(0, literalImport.start) + " ".repeat(literalImport.end - literalImport.start) + remaining.slice(literalImport.end)
  }
  if (/(?:^|[^\w$.#])import\s*\(/.test(remaining)) {
    throw new Error(`Deno ${outputName} contains an unsupported computed import. Use a static import so ViteHub can bundle its dependency.`)
  }
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
  for (const signal of signals) process.off(signal, handleSignal)
  await rm(uploadRoot, { force: true, recursive: true })
}
`
}

export async function finalizeDenoDeploymentOutput(
  options: FinalizeDenoDeploymentOutputOptions,
): Promise<void> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? ".output")
  const serverDir = join(outputDir, "server")
  const scheduleSource = join(options.rootDir, ".vitehub", "schedule", "deno-cron.mjs")
  const applicationEntrySource = join(options.rootDir, "main.ts")
  let entrypoint = "server/index.mjs"
  let hasSchedule = false
  try {
    await access(scheduleSource)
    if (options.hasScheduleIntegration === false) {
      await rm(scheduleSource, { force: true })
      throw Object.assign(new Error("stale Deno Schedule output"), { code: "ENOENT" })
    }
    hasSchedule = true
    await access(applicationEntrySource)
    await mkdir(join(outputDir, "schedule"), { recursive: true })
    const scheduleOutput = join(outputDir, "schedule", "deno-cron.mjs")
    const temporaryScheduleOutput = `${scheduleOutput}.vitehub-tmp`
    try {
      await bundleEsmEntry(scheduleSource, temporaryScheduleOutput, {
        external: [...builtinModuleNames],
        alias: options.alias,
        conditions: options.conditions,
        format: "esm",
        packages: "external",
        platform: "neutral",
        plugins: [packageImportPlugin()],
        rootDir: options.rootDir,
        workingDir: options.rootDir,
      })
      assertSupportedRelocatedImports(await readFile(temporaryScheduleOutput, "utf8"), "Schedule bundle")
      await rename(temporaryScheduleOutput, scheduleOutput)
    }
    finally {
      await rm(temporaryScheduleOutput, { force: true })
    }
    const applicationOutput = join(outputDir, "main.ts")
    const temporaryApplicationOutput = `${applicationOutput}.vitehub-tmp`
    try {
      await bundleEsmEntry(applicationEntrySource, temporaryApplicationOutput, {
        external: [...builtinModuleNames, "./schedule/deno-cron.mjs", "./server/index.mjs"],
        alias: options.alias,
        conditions: options.conditions,
        format: "esm",
        packages: "external",
        platform: "neutral",
        plugins: [packageImportPlugin()],
        rootDir: options.rootDir,
        workingDir: options.rootDir,
      })
      assertSupportedRelocatedImports(
        await readFile(temporaryApplicationOutput, "utf8"),
        "application entrypoint",
        ["./schedule/deno-cron.mjs", "./server/index.mjs"],
      )
      await rename(temporaryApplicationOutput, applicationOutput)
    }
    finally {
      await rm(temporaryApplicationOutput, { force: true })
    }
    entrypoint = "main.ts"
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (hasSchedule) {
      throw new Error('Deno Schedule output requires a project-root "main.ts" application entrypoint.', { cause: error })
    }
  }
  const packages = await readRuntimePackages([
    serverDir,
    ...(hasSchedule ? [join(outputDir, "schedule"), join(outputDir, "main.ts")] : []),
  ], options.rootDir)

  await copyRuntimePackagesToNodeModules({
    outputNodeModules: join(outputDir, "node_modules"),
    packages,
    rootDir: options.rootDir,
  })

  const denoConfig = {
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
  // Existing apps may retain this entrypoint; keep its import opaque to Deno's type checker.
  await writeFile(
    join(serverDir, "index.ts"),
    'await import("./index." + "mjs")\n',
    "utf8",
  )
  await writeFile(join(outputDir, "deno.json"), `${JSON.stringify(denoConfig, null, 2)}\n`, "utf8")
  await writeFile(join(outputDir, "deploy.mjs"), denoDeployRunnerSource(options.deploymentName, entrypoint), "utf8")
}
