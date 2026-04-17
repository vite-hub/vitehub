import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function resolveRuntimePath(
  importMetaUrl: string,
  srcRelative: string,
  pkgExport: string,
): string {
  const srcPath = resolve(dirname(fileURLToPath(importMetaUrl)), srcRelative)
  if (existsSync(srcPath)) return srcPath
  return fileURLToPath(import.meta.resolve(pkgExport))
}
