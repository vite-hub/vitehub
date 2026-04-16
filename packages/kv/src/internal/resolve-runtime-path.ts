import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function resolveRuntimePath(importMetaUrl: string, srcRelativePath: string, distRelativePath: string): string {
  const importerDir = dirname(fileURLToPath(importMetaUrl))
  const srcPath = resolve(importerDir, srcRelativePath)
  if (existsSync(srcPath)) return srcPath
  const distPath = resolve(importerDir, distRelativePath)
  if (existsSync(distPath)) return distPath
  return srcPath
}
