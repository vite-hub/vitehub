import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { basename, dirname, relative, resolve } from "pathe"

interface NuxtLayerDirectoryConfig {
  rootDir?: string
  serverDir?: string
  srcDir?: string
}

/** The Nuxt options that locate the server directory of each layer. */
export interface NuxtServerDirOptions extends NuxtLayerDirectoryConfig {
  _layers?: ReadonlyArray<{ config?: NuxtLayerDirectoryConfig, cwd?: string }>
}

export function generatedDirSegments(productName: string): readonly [".vitehub", string] {
  return [".vitehub", productName] as const
}

export function ensureGeneratedDir(rootDir: string, productName: string): string {
  return resolve(rootDir, ...generatedDirSegments(productName))
}

export function toGeneratedPath(rootDir: string, productName: string, filename: string): string {
  return relative(rootDir, resolve(rootDir, ...generatedDirSegments(productName), filename))
}

export function computePackageDir(importMetaUrl: string): string {
  const currentFileDir = dirname(fileURLToPath(importMetaUrl))
  return resolve(currentFileDir, basename(currentFileDir) === "internal" ? "../.." : "..")
}

export function resolveRuntimeModule(packageDir: string, modulePath: string): string {
  const distFile = resolve(packageDir, "dist", `${modulePath}.js`)
  return existsSync(distFile) ? distFile : resolve(packageDir, "src", `${modulePath}.ts`)
}

const packageDirs = new Map<string, string>()

function findPackageDir(file: string): string {
  const start = dirname(file)
  const cached = packageDirs.get(start)
  if (cached) return cached
  let dir = start
  while (!existsSync(resolve(dir, "package.json"))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`[vitehub] No package.json above ${file}.`)
    dir = parent
  }
  packageDirs.set(start, dir)
  return dir
}

/**
 * The absolute path of a module that the calling package builds, such as `ownModule(import.meta.url, "runtime/state")`.
 * Owner plugins write this path into generated code, so the module needs no package export, and an app resolves it
 * only when the owner's feature is on. It is the `dist` file, or the `src` file before the package is built.
 */
export function ownModule(importMetaUrl: string, modulePath: string): string {
  return resolveRuntimeModule(findPackageDir(fileURLToPath(importMetaUrl)), modulePath)
}

export function createImportPath(fromFile: string, targetFile: string): string {
  const fromDir = realpathIfExists(dirname(fromFile))
  const target = realpathIfExists(targetFile)
  const importPath = relative(fromDir, target)
  return importPath.startsWith(".") ? importPath : `./${importPath}`
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync.native(path)
  }
  catch {
    return resolve(path)
  }
}
