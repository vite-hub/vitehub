import { existsSync } from "node:fs"
import { cp, mkdir, readdir, rm } from "node:fs/promises"

import { dirname, relative, resolve } from "pathe"

export function hasStaticIndex(clientDir: string): boolean {
  return existsSync(resolve(clientDir, "index.html"))
}

export async function copyClientOutput(clientDir: string, targetDir: string, excludedDirs: string[] = []): Promise<void> {
  const resolvedClientDir = resolve(clientDir)
  const resolvedTargetDir = resolve(targetDir)
  if (resolvedClientDir === resolvedTargetDir) {
    return
  }
  const excluded = new Set(excludedDirs.map(dir => resolve(dir)))
  // A provider can share the client root; only omit nested provider directories.
  excluded.delete(resolvedClientDir)
  const filter = (source: string) => {
    const resolved = resolve(source)
    return ![...excluded].some(dir => resolved === dir || resolved.startsWith(`${dir}/`))
  }

  await rm(resolvedTargetDir, { force: true, recursive: true })
  await mkdir(dirname(resolvedTargetDir), { recursive: true })

  const targetRelativePath = relative(resolvedClientDir, resolvedTargetDir)
  if (targetRelativePath && !targetRelativePath.startsWith("../")) {
    const [targetRootEntry] = targetRelativePath.split("/", 1)
    await mkdir(resolvedTargetDir, { recursive: true })
    await Promise.all((await readdir(resolvedClientDir))
      .filter(entry => entry !== targetRootEntry)
      .map(entry => cp(resolve(resolvedClientDir, entry), resolve(resolvedTargetDir, entry), { recursive: true, filter })))
    return
  }

  await cp(resolvedClientDir, resolvedTargetDir, { recursive: true, filter })
}
