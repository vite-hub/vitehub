import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolveFs, sep } from 'pathe'
import { tryResolveModule } from './module-resolve'

function resolveExistingModulePath(path: string) {
  if (existsSync(path))
    return path

  for (const extension of ['.ts', '.mts', '.js', '.mjs']) {
    const withExtension = `${path}${extension}`
    if (existsSync(withExtension))
      return withExtension
  }

  return undefined
}

export function resolveFeatureRuntimePath(
  importMetaUrl: string,
  packageId: string,
  sourceRelativePath: string,
  distRelativePath: string,
) {
  const importerPath = fileURLToPath(importMetaUrl)
  const importerDir = dirname(importerPath)
  const sourcePath = resolveFs(importerDir, sourceRelativePath)
  const importerUsesDist = importerDir.split(sep).includes('dist')
  const targetsSourceTree = /(?:^|\/)\.\.\/src(?:\/|$)|^\.\/*src(?:\/|$)/.test(sourceRelativePath)
  const resolvedSourcePath = resolveExistingModulePath(sourcePath)

  if ((!importerUsesDist || !targetsSourceTree) && resolvedSourcePath)
    return resolvedSourcePath

  const resolvedPackageJson = tryResolveModule(`${packageId}/package.json`)
  if (resolvedPackageJson.ok) {
    const packageRoot = dirname(resolvedPackageJson.path)
    const packageSourcePath = join(
      packageRoot,
      'src',
      sourceRelativePath
        .replace(/^(\.\.\/)+src\//, '')
        .replace(/^\.\//, ''),
    )
    const resolvedPackageSourcePath = resolveExistingModulePath(packageSourcePath)
    if ((!importerUsesDist || !targetsSourceTree) && resolvedPackageSourcePath)
      return resolvedPackageSourcePath
    return join(dirname(resolvedPackageJson.path), 'dist', distRelativePath)
  }

  const resolvedPackage = tryResolveModule(packageId)
  if (resolvedPackage.ok)
    return join(dirname(resolvedPackage.path), distRelativePath)

  return sourcePath
}
