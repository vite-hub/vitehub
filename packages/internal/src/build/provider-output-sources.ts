import { existsSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

interface RetainProviderOutputSourcesOptions {
  artifactDir: string
  paths?: string[]
  roots: string[]
}

const ignoredSourceDirectories = new Set([
  ".git",
  ".netlify",
  ".nuxt",
  ".output",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
])

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

/** Retains one build generation's source trees while preserving every module's import base. */
export async function retainProviderOutputSources(options: RetainProviderOutputSourcesOptions): Promise<{
  resolve: (path: string) => string
}> {
  const artifactDir = resolve(options.artifactDir)
  const paths = [...new Set((options.paths ?? []).filter(isAbsolute).map(path => resolve(path)).filter(existsSync))]
  const configuredRoots = [...new Set(options.roots.map(root => resolve(root)).filter(existsSync))]
  const sourceRootByPath = new Map<string, string>()
  for (const path of paths) {
    const configuredRoot = configuredRoots
      .filter(root => pathContains(root, path))
      .sort((left, right) => right.length - left.length)[0]
    const nestedInDependencies = configuredRoot && relative(configuredRoot, path).split(sep).includes("node_modules")
    sourceRootByPath.set(path, configuredRoot && !nestedInDependencies ? configuredRoot : packageRoot(path))
  }
  for (const root of configuredRoots) sourceRootByPath.set(root, root)

  const roots = [...new Set(sourceRootByPath.values())]
  const retainedRoots = new Map(roots.map((root, index) => [root, resolve(artifactDir, String(index))]))
  await Promise.all(roots.map(async (root) => {
    const retainedRoot = retainedRoots.get(root)!
    const requested = paths.filter(path => pathContains(root, path))
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "vitehub-provider-sources-"))
    const stagedRoot = resolve(temporaryRoot, "source")
    try {
      await cp(root, stagedRoot, {
        recursive: true,
        filter(source) {
          const resolvedSource = resolve(source)
          if (pathContains(artifactDir, resolvedSource)) return false
          const nested = relative(root, resolvedSource)
          if (!nested) return true
          const first = nested.split(sep)[0]!
          if (first === ".vitehub" || ignoredSourceDirectories.has(first)) {
            return requested.some(path => pathContains(resolvedSource, path) || pathContains(path, resolvedSource))
          }
          return true
        },
      })
      await mkdir(dirname(retainedRoot), { recursive: true })
      try {
        await rename(stagedRoot, retainedRoot)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
        await cp(stagedRoot, retainedRoot, { recursive: true })
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
