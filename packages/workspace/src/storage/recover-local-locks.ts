import { readdir, lstat, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { workspaceError } from "../core/errors.ts"

/** Remove abandoned markers only after all processes using this local store have stopped. */
export async function recoverLocalWorkspaceLocks(options: {
  root: string
  offline: true
}): Promise<{ removed: number }> {
  if (options.offline !== true)
    throw workspaceError("[vitehub] Workspace lock recovery requires exclusive offline access.")
  const root = resolve(options.root)
  const directory = join(root, ".vitehub", "locks")
  for (const path of [root, join(root, ".vitehub"), directory]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return { removed: 0 }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw workspaceError(`[vitehub] Untrusted Workspace lock recovery path: ${path}.`)
  }
  let removed = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.(gate|readers)$/.test(entry.name)) continue
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw workspaceError(`[vitehub] Untrusted Workspace lock marker: ${entry.name}.`)
    await rm(join(directory, entry.name), { recursive: true })
    removed++
  }
  return { removed }
}
