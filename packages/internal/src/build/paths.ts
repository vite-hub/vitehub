import { existsSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function generatedDirSegments(productName: string): readonly [".vitehub", string] {
  return [".vitehub", productName] as const
}

export function ensureGeneratedDir(rootDir: string, productName: string): string {
  return resolve(rootDir, ...generatedDirSegments(productName))
}

export function toGeneratedPath(rootDir: string, productName: string, filename: string): string {
  return relative(rootDir, resolve(rootDir, ...generatedDirSegments(productName), filename)).replace(/\\/g, "/")
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
  const importPath = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return importPath.startsWith(".") ? importPath : `./${importPath}`
}
