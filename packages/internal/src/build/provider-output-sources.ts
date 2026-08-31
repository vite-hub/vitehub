import { existsSync, realpathSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"

import { build } from "esbuild"

import { findIdentifierCalls, maskSourceLiterals, stripBoundaryComments } from "../source-scanner.ts"

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

const traceableSourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"])

function isStaticModuleSpecifier(argument: string | undefined): boolean {
  if (!argument) return false
  const value = stripBoundaryComments(argument)
  return (value.startsWith('"') || value.startsWith("'")) && maskSourceLiterals(value).trim() === ""
}

function hasUnresolvedModuleRequest(source: string): boolean {
  for (const name of ["import", "require"]) {
    if (findIdentifierCalls(source, name).some(call => !isStaticModuleSpecifier(call.arguments[0]))) return true
  }
  return findIdentifierCalls(source, "createRequire").length > 0
}

async function traceImportedSources(paths: string[], root: string): Promise<Set<string> | undefined> {
  const entries = paths.filter(path => traceableSourceExtensions.has(extname(path)))
  if (!entries.length) return undefined
  try {
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      entryPoints: entries,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      outdir: resolve(root, ".vitehub-provider-trace"),
      packages: "external",
      platform: "node",
      write: false,
    })
    const importedSources = new Set(Object.keys(result.metafile.inputs).map(path => resolve(root, path)))
    const importedSourceContents = await Promise.all([...importedSources]
      .filter(path => traceableSourceExtensions.has(extname(path)))
      .map(async path => await readFile(path, "utf8")))
    if (importedSourceContents.some(hasUnresolvedModuleRequest)) return undefined
    return importedSources
  }
  catch {
    // Preserve source closure correctness when Vite-specific resolution cannot be traced here.
    return undefined
  }
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
  const retainedRoots = new Map(roots.map((root, index) => [root, resolve(artifactDir, String(index))]))
  await Promise.all(roots.map(async (root) => {
    const retainedRoot = retainedRoots.get(root)!
    const requested = paths.filter(path => path !== root && pathContains(root, path))
    const importedSources = await traceImportedSources(requested, root)
    const nestedConfiguredRoots = configuredRoots.filter(path => pathContains(root, path))
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
    const stagedRoot = resolve(temporaryRoot, "source")
    try {
      await cp(root, stagedRoot, {
        recursive: true,
        filter(source) {
          const resolvedSource = resolve(source)
          if (pathContains(artifactDir, resolvedSource)) return false
          if (isTransientSourceDirectory(resolvedSource)
            && !requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))) return false
          if (resolvedSource !== root
            && existsSync(resolve(resolvedSource, ".git"))
            && !requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
            && importedSources !== undefined
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
              || requestedOutputRoots.some(outputRoot => pathContains(outputRoot, resolvedSource))
              || configuredOutputClosures.some(outputRoot => pathContains(outputRoot, resolvedSource)
                && !relative(outputRoot, resolvedSource).split(sep).some(segment => ignoredSourceDirectories.has(segment)))
                && !nestedConfiguredRoots.some(configuredRoot => pathContains(configuredRoot, resolvedSource))
              || nestedConfiguredRoots.some(configuredRoot => pathContains(resolvedSource, configuredRoot))
          }
          return true
        },
      })
      await mkdir(dirname(retainedRoot), { recursive: true })
      try {
        await rename(stagedRoot, retainedRoot)
      }
      catch (error) {
        // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
        await cp(stagedRoot, retainedRoot, { recursive: true })
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
      const root = sourceRootByPath.get(resolvedPath)
        ?? roots.filter(candidate => pathContains(candidate, resolvedPath)).sort((left, right) => right.length - left.length)[0]
      return root ? resolve(retainedRoots.get(root)!, relative(root, resolvedPath)) : path
    },
  }
}
