import { existsSync } from "node:fs"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

export function hasStaticIndex(clientDir: string): boolean {
  return existsSync(resolve(clientDir, "index.html"))
}

export async function copyClientOutput(clientDir: string, targetDir: string): Promise<void> {
  const resolvedClientDir = resolve(clientDir)
  const resolvedTargetDir = resolve(targetDir)
  if (resolvedClientDir === resolvedTargetDir) {
    return
  }

  await rm(resolvedTargetDir, { force: true, recursive: true })
  await mkdir(dirname(resolvedTargetDir), { recursive: true })

  const targetRelativePath = relative(resolvedClientDir, resolvedTargetDir).replace(/\\/g, "/")
  if (targetRelativePath && !targetRelativePath.startsWith("../")) {
    const [targetRootEntry] = targetRelativePath.split("/", 1)
    await mkdir(resolvedTargetDir, { recursive: true })
    await Promise.all((await readdir(resolvedClientDir))
      .filter(entry => entry !== targetRootEntry)
      .map(entry => cp(resolve(resolvedClientDir, entry), resolve(resolvedTargetDir, entry), { recursive: true })))
    return
  }

  await cp(resolvedClientDir, resolvedTargetDir, { recursive: true })
}
