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
  // Exclude only provider directories inside the copied source tree. An output root
  // can contain the client directory and must not exclude that ancestor.
  const excluded = new Set<string>()
  for (const dir of excludedDirs) {
    const resolved = resolve(dir)
    if (resolved !== resolvedClientDir && resolved.startsWith(`${resolvedClientDir}/`)) {
      excluded.add(resolved)
    }
  }
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
