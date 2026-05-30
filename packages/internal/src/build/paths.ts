import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { basename, dirname, relative, resolve } from "pathe"

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
