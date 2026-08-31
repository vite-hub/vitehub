import { existsSync, lstatSync, realpathSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"

import { build } from "esbuild"

import { maskSourceLiterals } from "../source-scanner.ts"

interface RetainProviderOutputSourcesOptions {
  artifactDir: string
  paths?: string[]
  roots: string[]
}

interface RetainedProviderOutputSources {
  resolve: (path: string) => string
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

async function linkDependencies(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".pnpm") continue
    const sourceEntry = resolve(source, entry.name)
    const targetEntry = resolve(target, entry.name)
    if (!existsSync(sourceEntry)) continue
    const resolvedSourceEntry = realpathSync(sourceEntry)
    if (!statSync(resolvedSourceEntry).isDirectory()) continue
    if (entry.name.startsWith("@") && entry.isDirectory() && !entry.isSymbolicLink()) {
      await linkDependencies(sourceEntry, targetEntry)
      continue
    }
    if (existsSync(targetEntry)) continue
    await symlink(resolvedSourceEntry, targetEntry, process.platform === "win32" ? "junction" : "dir")
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

function resolveComputedModuleSource(file: string, specifier: string): string | undefined {
  try {
    const imported = createRequire(file).resolve(specifier)
    return existsSync(imported) ? imported : undefined
  }
  catch {
    return undefined
  }
}

function traceComputedModuleSources(file: string, source: string): string[] {
  const masked = maskSourceLiterals(source)
  const bindings = new Map<string, string>()
  const declarations = /\b(?:const|let|var)\s+([A-Z_$][\w$]*)\s*=\s*([`"'])(.*?)\2/gis
  for (const match of source.matchAll(declarations)) {
    const quoteOffset = match[0].indexOf(match[2]!)
    if (!/\b(?:const|let|var)\s+[A-Z_$][\w$]*\s*=\s*$/i.test(masked.slice(match.index, match.index + quoteOffset))) continue
    if (match[2] === "`" && match[3]!.includes("${")) continue
    bindings.set(match[1]!, match[3]!)
  }

  const paths: string[] = []
  const computedRequests = [
    /\b(?:import|require)\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi,
    /\bmodule\s*\.\s*require\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi,
    /\bcreateRequire\s*\([^)]*\)\s*\(\s*([A-Z_$][\w$]*)\s*\)/gi,
  ]
  for (const request of computedRequests) {
    for (const match of masked.matchAll(request)) {
      const specifier = bindings.get(match[1]!)
      if (!specifier || (!specifier.startsWith(".") && !isAbsolute(specifier))) continue
      const imported = resolveComputedModuleSource(file, specifier)
      if (!imported) continue
      paths.push(imported)
    }
  }

  const literalRequests = [
    {
      pattern: /\bmodule\s*\.\s*require\s*\(\s*(["'])(.*?)\1/gi,
      prefix: /\bmodule\s*\.\s*require\s*\(\s*$/i,
    },
    {
      pattern: /\bcreateRequire\s*\([^)]*\)\s*\(\s*(["'])(.*?)\1/gi,
      prefix: /\bcreateRequire\s*\([^)]*\)\s*\(\s*$/i,
    },
  ]
  for (const request of literalRequests) {
    for (const match of source.matchAll(request.pattern)) {
      const quoteOffset = match[0].indexOf(match[1]!)
      if (!request.prefix.test(masked.slice(match.index, match.index + quoteOffset))) continue
      const specifier = match[2]!
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue
      const imported = resolveComputedModuleSource(file, specifier)
      if (imported) paths.push(imported)
    }
  }

  return paths
}

async function traceImportedSources(paths: string[], root: string, configuredRoots: string[]): Promise<Set<string>> {
  const entries = paths.filter(path => traceableSourceExtensions.has(extname(path)))
  if (!entries.length) return new Set()
  try {
    const importedSources = new Set<string>()
    const scannedModuleRequestSources = new Set<string>()
    const tracedEntries = new Set<string>()
    let pendingEntries = entries
    while (pendingEntries.length) {
      const tracedBatch = pendingEntries
      pendingEntries = []
      for (const entry of tracedBatch) tracedEntries.add(entry)
      const queriedResourceSources = new Set<string>()
      const importedSourceHints = new Set<string>()
      const result = await build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: tracedBatch,
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outdir: resolve(root, ".vitehub-provider-trace"),
        packages: "external",
        platform: "node",
        plugins: [{
          name: "vitehub-provider-vite-resource-query",
          setup(traceBuild) {
            traceBuild.onResolve({ filter: /^\.\.?\// }, (request) => {
              const source = request.resolveDir && resolve(request.resolveDir, request.path.split(/[?#]/, 1)[0]!)
              if (source && existsSync(source)) importedSourceHints.add(source)
              return undefined
            })
            traceBuild.onResolve({ filter: /^#/ }, (request) => {
              if (!request.importer) return undefined
              const source = resolveComputedModuleSource(request.importer, request.path)
              if (source) importedSourceHints.add(source)
              return undefined
            })
            traceBuild.onResolve({ filter: /[?#]/ }, (request) => {
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
          },
        }],
        write: false,
      })
      for (const path of Object.keys(result.metafile.inputs)) importedSources.add(resolve(root, path))
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
    const sourceRoot = configuredRoot && !hasNestedPackage ? sourceClosureRoot(configuredRoot) : discoveredPackageRoot
    sourceRootByPath.set(path, sourceRoot)
    if (!configuredRoot || hasNestedPackage) packageRoots.add(sourceRoot)
  }
  for (const root of configuredRoots) sourceRootByPath.set(root, sourceClosureRoot(root))

  const roots = [...new Set(sourceRootByPath.values())]
  const retainedRoots = new Map<string, string>()
  const retainedPaths = new Map<string, string>()
  await Promise.all(roots.map(async (root, index) => {
    const requested = paths.filter(path => path !== root && pathContains(root, path))
    const nestedConfiguredRoots = configuredRoots.filter(path => pathContains(root, path))
    const importedSources = await traceImportedSources(requested, root, nestedConfiguredRoots)
    const materializedSourcePaths = [...requested, ...importedSources]
    const tsconfigSources = await tsconfigSourcesForPaths(root, materializedSourcePaths)
    materializedSourcePaths.push(...tsconfigSources)
    const captureRoot = commonSourceRoot(root, [...importedSources, ...tsconfigSources])
    const retainedContainer = resolve(artifactDir, String(index))
    const retainedRoot = resolve(retainedContainer, relative(captureRoot, root))
    retainedRoots.set(root, retainedRoot)
    const materializedSources = [...new Set([
      ...materializedSourcePaths,
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
      await mkdir(dirname(retainedContainer), { recursive: true })
      try {
        await rename(stagedContainer, retainedContainer)
      }
      catch (error) {
        // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
        await cp(stagedContainer, retainedContainer, { recursive: true })
      }
      for (const dependencies of dependencyRoots(root)) {
        await linkDependencies(dependencies, resolve(retainedRoot, "node_modules"))
      }
      for (const [target, dependencies] of nestedDependencyRoots) {
        await linkDependencies(dependencies, target)
      }
    }
    finally {
      await rm(temporaryRoot, { force: true, recursive: true })
    }
  }))

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
