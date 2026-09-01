import { existsSync, lstatSync, realpathSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"

import { createImportPath } from "./paths.ts"
import { findMatching, maskSourceLiterals, splitTopLevel } from "../source-scanner.ts"

interface RetainProviderOutputSourcesOptions {
  artifactDir: string
  paths?: string[]
  roots: string[]
}

interface RetainedProviderOutputSources {
  resolve: (path: string) => string
}

interface ProviderOutputSourceDestination {
  files: string[]
  runtimeSourcesDir: string
  sourcesDir: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Rewrites retained source paths after their snapshot is published to a durable generated directory. */
export function rewriteRetainedProviderSourcePaths(
  contents: string,
  retainedSourcesDir: string,
  publishedSourcesDir: string,
  importers?: { published: string, retained: string },
): string {
  const serializedRetainedSourcesDir = JSON.stringify(retainedSourcesDir).slice(1, -1)
  const serializedPublishedSourcesDir = JSON.stringify(publishedSourcesDir).slice(1, -1)
  const publishedSeparator = publishedSourcesDir.includes("\\") && !publishedSourcesDir.includes("/") ? "\\" : "/"
  const serializedPublishedSeparator = publishedSeparator === "\\" ? "\\\\" : "/"
  const serializedPath = new RegExp(`${escapeRegExp(serializedRetainedSourcesDir)}((?:(?:\\\\\\\\|/)[^"\\\\/]*)+)`, "g")
  const normalizedContents = contents.replace(serializedPath, (_matched, suffix: string) => {
    const normalizedSuffix = suffix.replaceAll("\\\\", serializedPublishedSeparator).replaceAll("/", serializedPublishedSeparator)
    return `${serializedPublishedSourcesDir}${normalizedSuffix}`
  })
  const replacements: Array<readonly [string, string]> = [
    [`${pathToFileURL(retainedSourcesDir).href}/`, `${pathToFileURL(publishedSourcesDir).href}/`],
    [`${serializedRetainedSourcesDir}\\\\`, `${serializedPublishedSourcesDir}${serializedPublishedSeparator}`],
    [`${serializedRetainedSourcesDir}/`, `${serializedPublishedSourcesDir}${serializedPublishedSeparator}`],
    [`${retainedSourcesDir}\\`, `${publishedSourcesDir}${publishedSeparator}`],
    [`${retainedSourcesDir}/`, `${publishedSourcesDir}${publishedSeparator}`],
  ]
  if (importers) {
    replacements.push([
      `${createImportPath(importers.retained, retainedSourcesDir)}/`,
      `${createImportPath(importers.published, publishedSourcesDir)}/`,
    ])
  }
  return replacements.reduce((rewritten, [source, destination]) => rewritten.replaceAll(source, destination), normalizedContents)
}

/** Repoints retained-tree symlinks at the matching paths in their durable published tree. */
export async function rebasePublishedProviderSourceLinks(
  stagedSourcesDir: string,
  retainedSourcesDir: string,
  publishedSourcesDir: string,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        return
      }
      if (!entry.isSymbolicLink()) return
      const link = await readlink(path)
      const retainedTarget = resolve(dirname(path), link)
      if (!pathContains(retainedSourcesDir, retainedTarget)) return
      const target = resolve(publishedSourcesDir, relative(retainedSourcesDir, retainedTarget))
      const publishedLink = resolve(publishedSourcesDir, relative(stagedSourcesDir, path))
      const targetType = await stat(retainedTarget).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!targetType) return
      const type = targetType.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file"
      const rebasedLink = type === "junction" ? target : relative(dirname(publishedLink), target) || "."
      await rm(path, { force: true, recursive: true })
      await symlink(rebasedLink, path, type)
    }))
  }
  await visit(stagedSourcesDir)
}

/** Copies durable generated sources into deployment artifacts and rewrites their serialized runtime location. */
export async function publishProviderSourcesToDeploymentOutputs(options: {
  destinations: ProviderOutputSourceDestination[]
  publishedSourcesDir: string
  signal?: AbortSignal
}): Promise<void> {
  await Promise.all(options.destinations.map(async (destination) => {
    options.signal?.throwIfAborted()
    await rm(destination.sourcesDir, { force: true, recursive: true })
    if (!existsSync(options.publishedSourcesDir)) return
    await mkdir(dirname(destination.sourcesDir), { recursive: true })
    await cp(options.publishedSourcesDir, destination.sourcesDir, { recursive: true })
    await rebasePublishedProviderSourceLinks(destination.sourcesDir, options.publishedSourcesDir, destination.sourcesDir)
    await Promise.all(destination.files.map(async (file) => {
      const contents = await readFile(file, "utf8")
      const rewritten = rewriteRetainedProviderSourcePaths(contents, options.publishedSourcesDir, destination.runtimeSourcesDir)
      if (rewritten !== contents) await writeFile(file, rewritten, { encoding: "utf8", signal: options.signal })
    }))
    options.signal?.throwIfAborted()
  }))
}

async function rebaseCapturedAbsoluteSourceLinks(
  stagedSourcesDir: string,
  sourceRoot: string,
  publishedSourcesDir: string,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        return
      }
      if (!entry.isSymbolicLink()) return
      const link = await readlink(path)
      if (!isAbsolute(link) || !pathContains(sourceRoot, link)) return
      const target = resolve(stagedSourcesDir, relative(sourceRoot, link))
      const publishedTarget = resolve(publishedSourcesDir, relative(sourceRoot, link))
      const targetType = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!targetType) return
      const type = targetType.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file"
      const rebasedLink = type === "junction" ? publishedTarget : relative(dirname(path), target) || "."
      await rm(path, { force: true, recursive: true })
      await symlink(rebasedLink, path, type)
    }))
  }
  await visit(stagedSourcesDir)
}

/** Rewrites both sides of absolute aliases and retains the original key for imports that still use it. */
export function retainProviderOutputAliases(
  aliases: Record<string, string>,
  retainedSources: RetainedProviderOutputSources,
): Record<string, string> {
  const retainedAliases: Record<string, string> = Object.create(null)
  const retain = (specifier: string, target: string): void => {
    if (!Object.hasOwn(retainedAliases, specifier)) retainedAliases[specifier] = target
  }
  for (const [specifier, target] of Object.entries(aliases)) {
    const retainedSpecifier = retainedSources.resolve(specifier)
    const retainedTarget = retainedSources.resolve(target)
    retain(specifier, retainedTarget)
    if (retainedSpecifier !== specifier) retain(retainedSpecifier, retainedTarget)
  }
  return retainedAliases
}

const ignoredSourceDirectories = new Set([
  ".git",
  ".netlify",
  ".nuxt",
  ".output",
  ".vercel",
  ".vitehub",
  ".vitest-tmp",
  "coverage",
  "dist",
  "node_modules",
])

const ignoredGeneratedDirectories = new Set([".vitehub", ".vitest-tmp"])

function isTransientSourceDirectory(path: string): boolean {
  return basename(path).startsWith(".drizzle-generate-")
}

function pathContains(parent: string, child: string): boolean {
  const nested = relative(parent, child)
  return !nested || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
}

function packageRoot(file: string): string {
  let current = statSync(file).isDirectory() ? file : dirname(file)
  while (true) {
    if (existsSync(resolve(current, "package.json"))) return current
    const parent = dirname(current)
    if (parent === current) return statSync(file).isDirectory() ? file : dirname(file)
    current = parent
  }
}

function boundSourceRootOutsideTemporaryStaging(root: string, source: string): string {
  if (!pathContains(root, resolve(tmpdir()))) return root
  return statSync(source).isDirectory() ? source : dirname(source)
}

function dependencyRoots(root: string): string[] {
  const resolvedRoot = realpathSync(root)
  const roots: string[] = []
  let current = resolvedRoot
  while (current !== dirname(current)) {
    const nested = resolve(current, "node_modules")
    if (existsSync(nested)) roots.push(nested)
    if (basename(current) === "node_modules") roots.push(current)
    current = dirname(current)
  }
  return [...new Set(roots)]
}

async function linkDependencies(
  source: string,
  target: string,
  resolveLinkTarget: (source: string) => string = source => source,
): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".pnpm") continue
    const sourceEntry = resolve(source, entry.name)
    const targetEntry = resolve(target, entry.name)
    if (!existsSync(sourceEntry)) continue
    const resolvedSourceEntry = realpathSync(sourceEntry)
    if (!statSync(resolvedSourceEntry).isDirectory()) continue
    if (entry.name.startsWith("@") && entry.isDirectory() && !entry.isSymbolicLink()) {
      await linkDependencies(sourceEntry, targetEntry, resolveLinkTarget)
      continue
    }
    if (existsSync(targetEntry)) continue
    await symlink(resolveLinkTarget(resolvedSourceEntry), targetEntry, process.platform === "win32" ? "junction" : "dir")
  }
}

/** Removes retained provider output after readers release it, tolerating transient filesystem contention. */
export async function removeProviderOutputArtifactDir(path: string): Promise<void> {
  await rm(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  })
}

function sourceClosureRoot(root: string): string {
  let current = root
  while (true) {
    if (existsSync(resolve(current, ".git")) || existsSync(resolve(current, "pnpm-workspace.yaml"))) return current
    const parent = dirname(current)
    if (parent === current) return root
    current = parent
  }
}

function commonSourceRoot(root: string, paths: Iterable<string>): string {
  let common = root
  for (const path of paths) {
    while (!pathContains(common, path)) {
      const parent = dirname(common)
      if (parent === common) return common
      common = parent
    }
  }
  return common
}

const traceableSourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"])

type RuntimeModuleRequestKind = "dynamic-import" | "require-call" | "require-resolve"

interface RuntimeModuleRequest {
  kind: RuntimeModuleRequestKind
  resolveFrom?: string
  specifier: string
}

function resolveComputedModuleSource(file: string, specifier: string, resolveFrom = file): string | undefined {
  try {
    const imported = createRequire(resolveFrom).resolve(specifier)
    return existsSync(imported) ? imported : undefined
  }
  catch {
    return undefined
  }
}

function traceComputedModuleSources(
  file: string,
  source: string,
  onRuntimePackageRequest?: (request: RuntimeModuleRequest) => void,
): string[] {
  const masked = maskSourceLiterals(source)
  const bindings = new Map<string, string>()
  const declarations = /\b(?:const|let|var)\s+([A-Z_$][\w$]*)\s*=\s*([`"'])(.*?)\2/gis
  for (const match of source.matchAll(declarations)) {
    const quoteOffset = match[0].indexOf(match[2]!)
    if (!/\b(?:const|let|var)\s+[A-Z_$][\w$]*\s*=\s*$/i.test(masked.slice(match.index, match.index + quoteOffset))) continue
    if (match[2] === "`" && match[3]!.includes("${")) continue
    bindings.set(match[1]!, match[3]!)
  }
  const createRequireNames = new Set(["createRequire"])
  const namedImports = /\bimport\s+(?:[A-Z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*([`"'])(?:node:)?module\2/gis
  for (const match of source.matchAll(namedImports)) {
    for (const specifier of match[1]!.split(",")) {
      const binding = /^\s*createRequire(?:\s+as\s+([A-Z_$][\w$]*))?\s*$/i.exec(specifier)?.[1]
      if (binding) createRequireNames.add(binding)
    }
  }
  const destructuredRequires = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*([`"'])(?:node:)?module\2\s*\)/gis
  for (const match of source.matchAll(destructuredRequires)) {
    for (const property of match[1]!.split(",")) {
      const binding = /^\s*createRequire(?:\s*:\s*([A-Z_$][\w$]*))?\s*$/i.exec(property)?.[1]
      if (binding) createRequireNames.add(binding)
    }
  }
  const createRequireNamespaceNames = new Set<string>()
  const defaultImports = /\bimport\s+([A-Z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Z_$][\w$]*))?\s+from\s*([`"'])(?:node:)?module\2/gis
  for (const match of source.matchAll(defaultImports)) createRequireNamespaceNames.add(match[1]!)
  const namespaceImports = /\bimport\s*\*\s*as\s*([A-Z_$][\w$]*)\s*from\s*([`"'])(?:node:)?module\2/gis
  for (const match of source.matchAll(namespaceImports)) createRequireNamespaceNames.add(match[1]!)
  const namespaceRequires = /\b(?:const|let|var)\s+([A-Z_$][\w$]*)\s*=\s*require\s*\(\s*([`"'])(?:node:)?module\2\s*\)/gis
  for (const match of source.matchAll(namespaceRequires)) createRequireNamespaceNames.add(match[1]!)
  const isCreateRequireExpression = (expression: string): boolean => {
    const normalized = expression.replace(/\s/g, "")
    if (createRequireNames.has(normalized)) return true
    const namespace = /^([A-Z_$][\w$]*)\.createRequire$/i.exec(normalized)?.[1]
    return Boolean(namespace && createRequireNamespaceNames.has(namespace))
  }
  const staticModuleSpecifier = (expression: string): string | undefined => {
    const normalized = expression.trim()
    const binding = /^([A-Z_$][\w$]*)$/i.exec(normalized)?.[1]
    if (binding) return bindings.get(binding)
    const literal = /^([`"'])([\s\S]*)\1$/.exec(normalized)
    if (!literal || (literal[1] === "`" && literal[2]!.includes("${"))) return undefined
    return literal[2]!
  }
  const createRequireBase = (expression: string): string => {
    const normalized = expression.trim()
    if (normalized === "import.meta.url" || normalized === "__filename") return file
    const direct = staticModuleSpecifier(normalized)
    if (direct) return direct
    const newUrl = /^new\s+URL\s*\(/i.exec(normalized)
    if (!newUrl) return file
    const openParen = normalized.indexOf("(", newUrl.index)
    const closeParen = findMatching(normalized, openParen, "(", ")")
    if (closeParen === undefined || normalized.slice(closeParen + 1).trim()) return file
    const [relativeUrl, baseUrl] = splitTopLevel(normalized.slice(openParen + 1, closeParen))
    const relativePath = relativeUrl ? staticModuleSpecifier(relativeUrl) : undefined
    if (!relativePath || baseUrl?.replace(/\s/g, "") !== "import.meta.url") return file
    return fileURLToPath(new URL(relativePath, pathToFileURL(file)))
  }
  const boundRequireBases = new Map<string, string>()
  const boundRequireDeclarations = /\b(?:const|let|var)\s+([A-Z_$][\w$]*)\s*=\s*([A-Z_$][\w$]*(?:\s*\.\s*createRequire)?)\s*\(/gi
  for (const match of masked.matchAll(boundRequireDeclarations)) {
    if (!isCreateRequireExpression(match[2]!)) continue
    const openParen = match.index + match[0].lastIndexOf("(")
    const closeParen = findMatching(masked, openParen, "(", ")")
    const base = closeParen === undefined ? file : createRequireBase(source.slice(openParen + 1, closeParen))
    boundRequireBases.set(match[1]!, base)
  }
  const boundResolveBases = new Map<string, string>()
  const recordBoundResolve = (properties: string, base: string): void => {
    const resolveBinding = properties
      .split(",")
      .map(property => /^\s*resolve(?:\s*:\s*([A-Z_$][\w$]*))?\s*$/i.exec(property))
      .find(Boolean)
    if (resolveBinding) boundResolveBases.set(resolveBinding[1] ?? "resolve", base)
  }
  const boundResolveDeclarations = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Z_$][\w$]*(?:\s*\.\s*createRequire)?)\s*\(/gi
  for (const match of masked.matchAll(boundResolveDeclarations)) {
    if (!isCreateRequireExpression(match[2]!)) continue
    const openParen = match.index + match[0].lastIndexOf("(")
    const closeParen = findMatching(masked, openParen, "(", ")")
    const base = closeParen === undefined ? file : createRequireBase(source.slice(openParen + 1, closeParen))
    recordBoundResolve(match[1]!, base)
  }
  const boundRequireResolveDeclarations = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Z_$][\w$]*)\b/gi
  for (const match of masked.matchAll(boundRequireResolveDeclarations)) {
    const base = boundRequireBases.get(match[2]!)
    if (base) recordBoundResolve(match[1]!, base)
  }

  const paths: string[] = []
  const recordRequest = (specifier: string, kind: RuntimeModuleRequestKind, resolveFrom = file): void => {
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
      onRuntimePackageRequest?.({ kind, resolveFrom, specifier })
      return
    }
    const imported = resolveComputedModuleSource(file, specifier, resolveFrom)
    if (imported) paths.push(imported)
  }
  const computedRequests = [
    { kind: "dynamic-import" as const, pattern: /\bimport\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi },
    { kind: "require-call" as const, pattern: /\brequire\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi },
    { kind: "dynamic-import" as const, pattern: /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi },
    { kind: "require-resolve" as const, pattern: /\brequire\s*\.\s*resolve\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi },
    { kind: "require-call" as const, pattern: /\bmodule\s*\.\s*require\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi },
  ]
  for (const request of computedRequests) {
    for (const match of masked.matchAll(request.pattern)) {
      const specifier = bindings.get(match[1]!)
      if (specifier) recordRequest(specifier, request.kind)
    }
  }
  const createdRequests = /\b([A-Z_$][\w$]*(?:\s*\.\s*createRequire)?)\s*\(/gi
  for (const match of masked.matchAll(createdRequests)) {
    if (!isCreateRequireExpression(match[1]!)) continue
    const openParen = match.index + match[0].lastIndexOf("(")
    const closeParen = findMatching(masked, openParen, "(", ")")
    if (closeParen === undefined) continue
    const invocation = /^\s*(?:\.\s*resolve\s*)?\(/i.exec(masked.slice(closeParen + 1))
    if (!invocation) continue
    const invocationOpenParen = closeParen + 1 + invocation[0].lastIndexOf("(")
    const invocationCloseParen = findMatching(masked, invocationOpenParen, "(", ")")
    if (invocationCloseParen === undefined) continue
    const [target] = splitTopLevel(source.slice(invocationOpenParen + 1, invocationCloseParen))
    const specifier = target ? staticModuleSpecifier(target) : undefined
    if (specifier) {
      const kind = /\.\s*resolve/i.test(invocation[0]) ? "require-resolve" : "require-call"
      recordRequest(specifier, kind, createRequireBase(source.slice(openParen + 1, closeParen)))
    }
  }
  const boundComputedRequests = /\b([A-Z_$][\w$]*)\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi
  for (const match of masked.matchAll(boundComputedRequests)) {
    const specifier = bindings.get(match[2]!)
    if (!specifier) continue
    const requireFrom = boundRequireBases.get(match[1]!)
    if (requireFrom) recordRequest(specifier, "require-call", requireFrom)
    const resolveFrom = boundResolveBases.get(match[1]!)
    if (resolveFrom) recordRequest(specifier, "require-resolve", resolveFrom)
  }
  const boundComputedResolveRequests = /\b([A-Z_$][\w$]*)\s*\.\s*resolve\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi
  for (const match of masked.matchAll(boundComputedResolveRequests)) {
    const resolveFrom = boundRequireBases.get(match[1]!)
    if (!resolveFrom) continue
    const specifier = bindings.get(match[2]!)
    if (specifier) recordRequest(specifier, "require-resolve", resolveFrom)
  }
  const literalRequests = [
    {
      kind: "dynamic-import" as const,
      pattern: /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(\s*([`"'])(.*?)\1/gi,
      prefix: /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(\s*$/i,
    },
    {
      kind: "require-resolve" as const,
      pattern: /\brequire\s*\.\s*resolve\s*\(\s*([`"'])(.*?)\1/gi,
      prefix: /\brequire\s*\.\s*resolve\s*\(\s*$/i,
    },
    {
      kind: "require-call" as const,
      pattern: /\bmodule\s*\.\s*require\s*\(\s*([`"'])(.*?)\1/gi,
      prefix: /\bmodule\s*\.\s*require\s*\(\s*$/i,
    },
  ]
  for (const request of literalRequests) {
    for (const match of source.matchAll(request.pattern)) {
      const quoteOffset = match[0].indexOf(match[1]!)
      if (!request.prefix.test(masked.slice(match.index, match.index + quoteOffset))) continue
      const specifier = match[2]!
      if (match[1] === "`" && specifier.includes("${")) continue
      recordRequest(specifier, request.kind)
    }
  }
  const boundLiteralRequests = /\b([A-Z_$][\w$]*)\s*\(\s*([`"'])(.*?)\2/gis
  for (const match of source.matchAll(boundLiteralRequests)) {
    const requireFrom = boundRequireBases.get(match[1]!)
    const resolveFrom = boundResolveBases.get(match[1]!)
    if (!requireFrom && !resolveFrom) continue
    const quoteOffset = match[0].indexOf(match[2]!)
    if (!/\b[A-Z_$][\w$]*\s*\(\s*$/i.test(masked.slice(match.index, match.index + quoteOffset))) continue
    const specifier = match[3]!
    if (match[2] === "`" && specifier.includes("${")) continue
    if (requireFrom) recordRequest(specifier, "require-call", requireFrom)
    if (resolveFrom) recordRequest(specifier, "require-resolve", resolveFrom)
  }
  const boundLiteralResolveRequests = /\b([A-Z_$][\w$]*)\s*\.\s*resolve\s*\(\s*([`"'])(.*?)\2/gis
  for (const match of source.matchAll(boundLiteralResolveRequests)) {
    const resolveFrom = boundRequireBases.get(match[1]!)
    if (!resolveFrom) continue
    const quoteOffset = match[0].indexOf(match[2]!)
    if (!/\b[A-Z_$][\w$]*\s*\.\s*resolve\s*\(\s*$/i.test(masked.slice(match.index, match.index + quoteOffset))) continue
    const specifier = match[3]!
    if (match[2] === "`" && specifier.includes("${")) continue
    recordRequest(specifier, "require-resolve", resolveFrom)
  }
  return paths
}

async function traceImportedSources(paths: string[], root: string, configuredRoots: string[]): Promise<Set<string>> {
  const entries = paths.filter(path => traceableSourceExtensions.has(extname(path)))
  if (!entries.length) return new Set()
  const physicalRoot = realpathSync(root)
  const traceBuildVariants = [
    { platform: "node" as const },
    { platform: "neutral" as const },
    { conditions: ["workerd", "worker", "browser", "default"], platform: "neutral" as const },
    { conditions: ["vitehub-hosted", "workerd", "worker", "browser", "default"], platform: "neutral" as const },
    { conditions: ["vitehub-hosted", "node", "default"], platform: "node" as const },
  ]
  try {
    const importedSources = new Set(entries)
    const scannedModuleRequestSources = new Set<string>()
    const tracedEntries = new Set<string>()
    let pendingEntries = entries
    while (pendingEntries.length) {
      const tracedBatch = pendingEntries
      pendingEntries = []
      for (const entry of tracedBatch) tracedEntries.add(entry)
      const queriedResourceSources = new Set<string>()
      const importedSourceHints = new Set<string>()
      const results = []
      // A retained root can pull in the full application graph. Run its host-condition variants
      // sequentially so the two-root worker limit also bounds concurrent esbuild graphs.
      for (const variant of traceBuildVariants) {
        const [result] = await Promise.allSettled([build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: tracedBatch,
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outdir: resolve(root, ".vitehub-provider-trace"),
        packages: "bundle",
        ...variant,
        plugins: [{
          name: "vitehub-provider-vite-resource-query",
          setup(traceBuild) {
            const resolvingPackageImportHint = "vitehubResolvingPackageImportHint"
            traceBuild.onResolve({ filter: /^\.\.?\// }, (request) => {
              const source = request.resolveDir && resolve(request.resolveDir, request.path.split(/[?#]/, 1)[0]!)
              if (source && existsSync(source)) importedSourceHints.add(source)
              return undefined
            })
            traceBuild.onResolve({ filter: /^#/ }, async (request) => {
              if (request.pluginData?.[resolvingPackageImportHint]) return undefined
              if (!request.importer) return undefined
              const suffixOffset = request.path.slice(1).search(/[?#]/)
              const packageImport = suffixOffset === -1 ? request.path : request.path.slice(0, suffixOffset + 1)
              const resolution = await traceBuild.resolve(packageImport, {
                importer: request.importer,
                kind: request.kind,
                namespace: request.namespace,
                pluginData: { ...request.pluginData, [resolvingPackageImportHint]: true },
                resolveDir: request.resolveDir,
                with: request.with,
              })
              if (!resolution.errors.length && !resolution.external && resolution.namespace === "file" && existsSync(resolution.path)) {
                importedSourceHints.add(resolution.path)
              }
              return undefined
            })
            const resolvingBarePackageHint = "vitehubResolvingBarePackageHint"
            traceBuild.onResolve({ filter: /^[^./#]/ }, async (request) => {
              if (request.pluginData?.[resolvingBarePackageHint]) return undefined
              if (!request.importer) return undefined
              const suffixOffset = request.path.search(/[?#]/)
              const packageImport = suffixOffset === -1 ? request.path : request.path.slice(0, suffixOffset)
              const resolution = await traceBuild.resolve(packageImport, {
                importer: request.importer,
                kind: request.kind,
                namespace: request.namespace,
                pluginData: { ...request.pluginData, [resolvingBarePackageHint]: true },
                resolveDir: request.resolveDir,
                with: request.with,
              })
              const source = pathContains(root, resolution.path)
                ? resolution.path
                : pathContains(physicalRoot, resolution.path)
                  ? resolve(root, relative(physicalRoot, resolution.path))
                  : undefined
              if (!resolution.errors.length && !resolution.external && resolution.namespace === "file"
                && source && existsSync(source)
                && !relative(root, source).split(sep).includes("node_modules")) {
                importedSourceHints.add(source)
              }
              return { external: true, path: request.path }
            })
            traceBuild.onResolve({ filter: /[?#]/ }, (request) => {
              if (request.pluginData?.[resolvingPackageImportHint]) return undefined
              const resourcePath = request.path.split(/[?#]/, 1)[0]!
              let resourceSource: string | undefined
              if (request.resolveDir && (resourcePath.startsWith("./") || resourcePath.startsWith("../"))) {
                resourceSource = resolve(request.resolveDir, resourcePath)
              }
              else if (request.resolveDir && resourcePath.startsWith("/")) {
                const projectRoot = configuredRoots
                  .filter(configuredRoot => pathContains(configuredRoot, request.resolveDir))
                  .sort((left, right) => right.length - left.length)[0] ?? root
                const rootRelativePath = resourcePath.slice(1)
                const publicSource = resolve(projectRoot, "public", rootRelativePath)
                resourceSource = existsSync(publicSource) ? publicSource : resolve(projectRoot, rootRelativePath)
              }
              if (resourceSource && existsSync(resourceSource)) queriedResourceSources.add(resourceSource)
              return { external: true, path: request.path }
            })
            traceBuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (request) => {
              const sourcePath = pathContains(root, request.path)
                ? request.path
                : pathContains(physicalRoot, request.path)
                  ? resolve(root, relative(physicalRoot, request.path))
                  : undefined
              if (!sourcePath || relative(root, sourcePath).split(sep).includes("node_modules")) return undefined
              const source = await readFile(request.path, "utf8").catch(() => undefined)
              if (!source) return undefined
              const runtimeRequests = new Map<string, RuntimeModuleRequest>()
              traceComputedModuleSources(request.path, source, (runtimeRequest) => {
                runtimeRequests.set(`${runtimeRequest.kind}\0${runtimeRequest.resolveFrom}\0${runtimeRequest.specifier}`, runtimeRequest)
              })
              await Promise.all([...runtimeRequests.values()].map(async runtimeRequest => {
                const resolveFrom = runtimeRequest.resolveFrom ?? request.path
                const resolution = await traceBuild.resolve(runtimeRequest.specifier, {
                  importer: resolveFrom,
                  kind: runtimeRequest.kind,
                  namespace: request.namespace,
                  resolveDir: dirname(resolveFrom),
                })
                const resolvedSource = pathContains(root, resolution.path)
                  ? resolution.path
                  : pathContains(physicalRoot, resolution.path)
                    ? resolve(root, relative(physicalRoot, resolution.path))
                    : undefined
                if (!resolution.errors.length && !resolution.external && resolution.namespace === "file"
                  && resolvedSource && existsSync(resolvedSource)
                  && !relative(root, resolvedSource).split(sep).includes("node_modules")) {
                  importedSourceHints.add(resolvedSource)
                }
              }))
              return undefined
            })
          },
        }],
        write: false,
        })])
        if (result?.status === "fulfilled") results.push(result.value)
      }
      for (const result of results) {
        for (const path of Object.keys(result.metafile.inputs)) importedSources.add(resolve(root, path))
      }
      for (const path of importedSourceHints) {
        importedSources.add(path)
        if (traceableSourceExtensions.has(extname(path)) && !tracedEntries.has(path)) pendingEntries.push(path)
      }
      for (const resourceSource of queriedResourceSources) {
        importedSources.add(resourceSource)
        if (traceableSourceExtensions.has(extname(resourceSource)) && !tracedEntries.has(resourceSource)) {
          pendingEntries.push(resourceSource)
        }
      }
      const moduleRequestSources = [...importedSources]
        .filter(path => traceableSourceExtensions.has(extname(path)) && !scannedModuleRequestSources.has(path))
      const moduleRequestSourceContents = await Promise.all(moduleRequestSources
        .map(async path => [path, await readFile(path, "utf8")] as const))
      for (const [file, source] of moduleRequestSourceContents) {
        scannedModuleRequestSources.add(file)
        for (const imported of traceComputedModuleSources(file, source)) {
          importedSources.add(imported)
          if (traceableSourceExtensions.has(extname(imported))
            && !tracedEntries.has(imported)
            && !pendingEntries.includes(imported)) pendingEntries.push(imported)
        }
      }
    }
    return importedSources
  }
  catch {
    // Requested entries remain available even when Vite-specific resolution cannot be traced here.
    return new Set(entries)
  }
}

function symlinkSourcesForRequestedPath(root: string, path: string): string[] {
  const sources: string[] = []
  let current = path
  while (pathContains(root, current)) {
    if (lstatSync(current).isSymbolicLink()) sources.push(current)
    if (current === root) break
    current = dirname(current)
  }
  return sources.reverse()
}

function packageMetadataSourcesForPath(root: string, path: string): string[] {
  const sources: string[] = []
  let current = statSync(path).isDirectory() ? path : dirname(path)
  while (pathContains(root, current)) {
    const packageJson = resolve(current, "package.json")
    if (existsSync(packageJson)) sources.push(packageJson)
    if (current === root) break
    current = dirname(current)
  }
  return sources
}

function parseJsonWithComments(source: string): unknown {
  let output = ""
  let blockComment = false
  let lineComment = false
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false
        output += char
      }
      else output += " "
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        output += "  "
        index += 1
      }
      else output += char === "\n" || char === "\r" ? char : " "
      continue
    }
    if (!quoted && char === "/" && next === "/") {
      lineComment = true
      output += "  "
      index += 1
      continue
    }
    if (!quoted && char === "/" && next === "*") {
      blockComment = true
      output += "  "
      index += 1
      continue
    }
    output += char
    if (char === "\"") {
      let backslashes = 0
      for (let previous = index - 1; source[previous] === "\\"; previous -= 1) backslashes += 1
      if (backslashes % 2 === 0) quoted = !quoted
    }
  }
  let withoutTrailingCommas = ""
  quoted = false
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]!
    if (char === "\"") {
      let backslashes = 0
      for (let previous = index - 1; output[previous] === "\\"; previous -= 1) backslashes += 1
      if (backslashes % 2 === 0) quoted = !quoted
    }
    if (!quoted && char === ",") {
      let next = index + 1
      while (/\s/.test(output[next] ?? "")) next += 1
      if (output[next] === "}" || output[next] === "]") continue
    }
    withoutTrailingCommas += char
  }
  return JSON.parse(withoutTrailingCommas)
}

function resolveTsconfigReference(config: string, reference: string): string | undefined {
  const candidates = reference.startsWith(".") || isAbsolute(reference)
    ? [resolve(dirname(config), reference), resolve(dirname(config), `${reference}.json`), resolve(dirname(config), reference, "tsconfig.json")]
    : [reference, `${reference}/tsconfig.json`]
  for (const candidate of candidates) {
    try {
      const resolved = isAbsolute(candidate) ? candidate : createRequire(config).resolve(candidate)
      if (existsSync(resolved)) return resolved
    }
    catch {
      // Try the next TypeScript-compatible config reference form.
    }
  }
}

async function tsconfigSourcesForPaths(root: string, paths: string[]): Promise<string[]> {
  const pending: string[] = []
  for (const path of paths) {
    let current = statSync(path).isDirectory() ? path : dirname(path)
    while (pathContains(root, current)) {
      const config = resolve(current, "tsconfig.json")
      if (existsSync(config)) {
        pending.push(config)
        break
      }
      if (current === root) break
      current = dirname(current)
    }
  }

  const sources = new Set<string>()
  while (pending.length) {
    const config = pending.pop()!
    if (sources.has(config)) continue
    sources.add(config)
    try {
      // SAFETY: TypeScript config inheritance only reads the optional string or string-array `extends` field.
      const parsed = parseJsonWithComments(await readFile(config, "utf8")) as { extends?: string | string[] }
      const references = Array.isArray(parsed.extends) ? parsed.extends : parsed.extends ? [parsed.extends] : []
      for (const reference of references) {
        const resolved = resolveTsconfigReference(config, reference)
        if (resolved && !sources.has(resolved)) pending.push(resolved)
      }
    }
    catch {
      // The bundler remains responsible for reporting invalid TypeScript configuration.
    }
  }
  return [...sources]
}

/** Retains one build generation's source trees while preserving every module's import base. */
export async function retainProviderOutputSources(options: RetainProviderOutputSourcesOptions): Promise<{
  resolve: (path: string) => string
}> {
  const artifactDir = resolve(options.artifactDir)
  const paths = [...new Set((options.paths ?? []).filter(isAbsolute).map(path => resolve(path)).filter(existsSync))]
  const configuredRoots = [...new Set(options.roots.map(root => resolve(root)).filter(existsSync))]
  const sourceRootByPath = new Map<string, string>()
  const packageRoots = new Set<string>()
  for (const path of paths) {
    const configuredRoot = configuredRoots
      .filter(root => pathContains(root, path))
      .sort((left, right) => right.length - left.length)[0]
    const pathSegments = configuredRoot ? relative(configuredRoot, path).split(sep) : []
    const nestedInRetainedOutput = pathSegments.includes(".vitehub") || pathSegments.includes("node_modules")
    const discoveredPackageRoot = packageRoot(path)
    const hasNestedPackage = Boolean(configuredRoot && nestedInRetainedOutput && discoveredPackageRoot !== configuredRoot)
    const discoveredSourceRoot = configuredRoot && !hasNestedPackage ? sourceClosureRoot(configuredRoot) : discoveredPackageRoot
    const sourceRoot = boundSourceRootOutsideTemporaryStaging(discoveredSourceRoot, path)
    sourceRootByPath.set(path, sourceRoot)
    if (!configuredRoot || hasNestedPackage) packageRoots.add(sourceRoot)
  }
  for (const root of configuredRoots) {
    sourceRootByPath.set(root, boundSourceRootOutsideTemporaryStaging(sourceClosureRoot(root), root))
  }

  const roots = [...new Set(sourceRootByPath.values())]
  const retainedRoots = new Map<string, string>()
  const retainedPaths = new Map<string, string>()
  const pendingRoots = roots.entries()
  let firstFailure: { error: unknown } | undefined
  const retainNextRoot = async (): Promise<void> => {
    if (firstFailure) return
    const next = pendingRoots.next()
    if (next.done) return
    const [index, root] = next.value
    const requested = paths.filter(path => path !== root && pathContains(root, path))
    const nestedConfiguredRoots = configuredRoots.filter(path => pathContains(root, path))
    const importedSources = await traceImportedSources(requested, root, nestedConfiguredRoots)
    const materializedSourcePaths = [...requested, ...importedSources]
    const tsconfigSources = await tsconfigSourcesForPaths(root, materializedSourcePaths)
    materializedSourcePaths.push(...tsconfigSources)
    const governingPackageMetadata = materializedSourcePaths
      .flatMap(path => packageMetadataSourcesForPath(packageRoot(path), path))
    const captureRoot = commonSourceRoot(root, [...importedSources, ...tsconfigSources, ...governingPackageMetadata])
    const retainedContainer = resolve(artifactDir, String(index))
    const retainedRoot = resolve(retainedContainer, relative(captureRoot, root))
    retainedRoots.set(root, retainedRoot)
    const materializedSources = [...new Set([
      ...materializedSourcePaths,
      ...governingPackageMetadata,
      ...materializedSourcePaths.flatMap(path => packageMetadataSourcesForPath(captureRoot, path)),
    ])]
    for (const source of materializedSources.filter(source => !pathContains(root, source))) {
      retainedPaths.set(source, resolve(retainedContainer, relative(captureRoot, source)))
    }
    const requestedSymlinks = [...new Set([root, ...materializedSources].flatMap(path => symlinkSourcesForRequestedPath(root, path)))]
      .sort((left, right) => relative(root, left).split(sep).length - relative(root, right).split(sep).length)
    const configuredOutputClosures = nestedConfiguredRoots.flatMap((configuredRoot) => {
      const segments = relative(root, configuredRoot).split(sep)
      const ignoredIndex = segments.findIndex(segment => ignoredGeneratedDirectories.has(segment))
      if (ignoredIndex === -1 || ignoredIndex === segments.length - 1) return []
      return [resolve(root, ...segments.slice(0, ignoredIndex + 2))]
    })
    const requestedOutputRoots = requested.flatMap((path) => {
      const configuredRoot = nestedConfiguredRoots
        .filter(root => pathContains(root, path))
        .sort((left, right) => right.length - left.length)[0]
      const scopedRoot = configuredRoot ?? root
      const segments = relative(scopedRoot, path).split(sep)
      const ignoredIndex = segments.findIndex(segment => ignoredSourceDirectories.has(segment))
      if (ignoredIndex === -1) return []
      const generationIndex = ignoredGeneratedDirectories.has(segments[ignoredIndex]!)
        && segments[ignoredIndex + 1]?.endsWith("-generations")
        ? ignoredIndex + 1
        : -1
      const retainedSourcesIndex = generationIndex === ignoredIndex + 1
        ? segments.findIndex((segment, index) => index > generationIndex && (segment === "sources" || segment.endsWith("-sources")))
        : -1
      const generatedOutputIndex = ignoredGeneratedDirectories.has(segments[ignoredIndex]!)
        ? Math.min(ignoredIndex + 1, segments.length - 1)
        : ignoredIndex
      const outputRootIndex = retainedSourcesIndex !== -1
        ? retainedSourcesIndex
        : generationIndex !== -1
          ? Math.min(generationIndex + 1, segments.length - 1)
          : generatedOutputIndex
      return [resolve(scopedRoot, ...segments.slice(0, outputRootIndex + 1))]
    })
    const nestedDependencyRoots = new Map<string, string>()
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "vitehub-provider-sources-"))
    const stagedContainer = resolve(temporaryRoot, "source")
    const stagedRoot = resolve(stagedContainer, relative(captureRoot, root))
    try {
      const shouldCopySource = (resolvedSource: string): boolean => {
        if (pathContains(artifactDir, resolvedSource)) return false
        if (isTransientSourceDirectory(resolvedSource)
          && !requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))) return false
        if (resolvedSource !== root
          && existsSync(resolve(resolvedSource, ".git"))
          && !requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
          && ![...importedSources].some(path => pathContains(resolvedSource, path))
          && !nestedConfiguredRoots.some(configuredRoot => pathContains(resolvedSource, configuredRoot))
          && !configuredOutputClosures.some(outputRoot => pathContains(outputRoot, resolvedSource))) return false
        const nested = relative(root, resolvedSource)
        if (!nested) return true
        const segments = nested.split(sep)
        const dependencyIndex = segments.indexOf("node_modules")
        if (dependencyIndex !== -1) {
          if (dependencyIndex === segments.length - 1 && dirname(resolvedSource) !== root) {
            nestedDependencyRoots.set(resolve(retainedRoot, nested), resolvedSource)
          }
          return false
        }
        const first = segments[0]!
        const containingConfiguredRoot = nestedConfiguredRoots
          .filter(configuredRoot => pathContains(configuredRoot, resolvedSource))
          .sort((left, right) => right.length - left.length)[0]
        const scopedSegments = relative(containingConfiguredRoot ?? root, resolvedSource).split(sep)
        const scopedFirst = containingConfiguredRoot ? scopedSegments[0] : first
        if (scopedFirst === ".nuxt") {
          return requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
            || scopedSegments.length === 1
            || (scopedSegments.length === 2 && /^tsconfig(?:\.[^.]+)?\.json$/i.test(scopedSegments[1]!))
        }
        const nestedGeneratedOutput = scopedSegments
          .some(segment => ignoredGeneratedDirectories.has(segment))
        if (nestedGeneratedOutput || (scopedFirst && ignoredSourceDirectories.has(scopedFirst)
          && !(packageRoots.has(root) && !containingConfiguredRoot && scopedFirst === "dist"))) {
          return requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
            || [...importedSources].some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
            || requestedOutputRoots.some(outputRoot => pathContains(outputRoot, resolvedSource))
            || configuredOutputClosures.some(outputRoot => pathContains(outputRoot, resolvedSource)
              && !relative(outputRoot, resolvedSource).split(sep).some(segment => ignoredSourceDirectories.has(segment)))
              && !nestedConfiguredRoots.some(configuredRoot => pathContains(configuredRoot, resolvedSource))
            || nestedConfiguredRoots.some(configuredRoot => pathContains(resolvedSource, configuredRoot))
        }
        return true
      }
      await cp(root, stagedRoot, {
        recursive: true,
        filter: source => shouldCopySource(resolve(source)),
      })
      const escapedMaterializedSources = materializedSources
        .filter(source => !pathContains(root, source))
        .filter((source, _, sources) => !sources.some(parent => parent !== source
          && statSync(parent).isDirectory()
          && pathContains(parent, source)))
      for (const source of escapedMaterializedSources) {
        const retainedSource = resolve(stagedContainer, relative(captureRoot, source))
        await mkdir(dirname(retainedSource), { recursive: true })
        await cp(realpathSync(source), retainedSource, { recursive: statSync(source).isDirectory() })
      }
      for (const source of requestedSymlinks) {
        const retainedSource = resolve(stagedRoot, relative(root, source))
        const sourceTarget = realpathSync(source)
        await rm(retainedSource, { force: true, recursive: true })
        await cp(sourceTarget, retainedSource, {
          recursive: statSync(source).isDirectory(),
          filter(candidate) {
            const physicalCandidate = resolve(candidate)
            const logicalCandidate = resolve(source, relative(sourceTarget, physicalCandidate))
            const retained = materializedSources.some(path => pathContains(logicalCandidate, path)
              || pathContains(path, logicalCandidate)
              || pathContains(physicalCandidate, path)
              || pathContains(path, physicalCandidate))
            return retained && shouldCopySource(logicalCandidate)
          },
        })
      }
      await rebaseCapturedAbsoluteSourceLinks(stagedContainer, captureRoot, retainedContainer)
      await mkdir(dirname(retainedContainer), { recursive: true })
      try {
        await rename(stagedContainer, retainedContainer)
      }
      catch (error) {
        // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
        await cp(stagedContainer, retainedContainer, { recursive: true })
      }
      const resolveRetainedDependencyTarget = (source: string): string => {
        if (!pathContains(root, source) || relative(root, source).split(sep).includes("node_modules")) return source
        const retainedSource = resolve(retainedRoot, relative(root, source))
        return existsSync(retainedSource) ? retainedSource : source
      }
      for (const dependencies of dependencyRoots(root)) {
        await linkDependencies(dependencies, resolve(retainedRoot, "node_modules"), resolveRetainedDependencyTarget)
      }
      for (const source of escapedMaterializedSources) {
        const sourceDirectory = statSync(source).isDirectory() ? source : dirname(source)
        for (const dependencies of dependencyRoots(sourceDirectory)) {
          const target = pathContains(captureRoot, dependencies)
            ? resolve(retainedContainer, relative(captureRoot, dependencies))
            : resolve(retainedContainer, "node_modules")
          await linkDependencies(dependencies, target, resolveRetainedDependencyTarget)
        }
      }
      for (const [target, dependencies] of nestedDependencyRoots) {
        await linkDependencies(dependencies, target, resolveRetainedDependencyTarget)
      }
    }
    finally {
      await rm(temporaryRoot, { force: true, recursive: true })
    }
    await retainNextRoot()
  }
  // Each root fans out across several esbuild traces. Two workers bound memory without serializing large consumer builds.
  await Promise.all(Array.from({ length: Math.min(2, roots.length) }, async () => {
    try {
      await retainNextRoot()
    }
    catch (error) {
      firstFailure ??= { error }
    }
  }))
  if (firstFailure) throw firstFailure.error

  return {
    resolve(path) {
      if (!isAbsolute(path)) return path
      const resolvedPath = resolve(path)
      const retainedPath = retainedPaths.get(resolvedPath)
      if (retainedPath) return retainedPath
      const root = sourceRootByPath.get(resolvedPath)
        ?? roots.filter(candidate => pathContains(candidate, resolvedPath)).sort((left, right) => right.length - left.length)[0]
      return root ? resolve(retainedRoots.get(root)!, relative(root, resolvedPath)) : path
    },
  }
}
